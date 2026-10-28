import { CONSOLE_ORIGIN, withA8Session, type A8SmokeResult } from "./a8-login.js";
import { READ_PAGE_DETAILS, openProgramPage, siteSelectFlags, type SiteOption, type SiteSelectFlags } from "./a8-inspect.js";
import {
  DUMP_TREE,
  hrefShape,
  listState,
  programIdOf,
  readListPage,
  renderProbe,
  type ListState,
  type ProbeNode,
  type RawProgramRow,
} from "./a8-programs.js";

/**
 * Read-only look at the ad-link page (広告リンク作成) of one joined program. Nothing is pressed
 * and no link is generated. Its structure is printed with every piece of content masked, and
 * what the site selector offers is reduced to flags, so the link-making step can be built from
 * what is really there. The log is public; the account's sites and links stay out of it.
 */

const CREATE_LINK_PATH = "/program/create-link";
const KEYWORD_MAX_LENGTH = 40;

/** The row's own ad-link page, as a path and query. Never another program's, another origin's, or a lookalike. */
export function pickCreateLinkPath(row: RawProgramRow): string | undefined {
  for (const href of row.hrefs) {
    if (!href || /%2e|\.\./i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, CONSOLE_ORIGIN);
    } catch {
      continue;
    }
    if (url.origin === CONSOLE_ORIGIN && url.pathname === CREATE_LINK_PATH && programIdOf(url.search) === row.programId) {
      return `${url.pathname}${url.search}`;
    }
  }
  return undefined;
}

interface DetailsRead {
  selects: { name: string; options: SiteOption[] }[];
}

export interface LinkProbeReport {
  outcome: "ok" | "login_failed" | "not_found" | "unrecognized";
  login?: A8SmokeResult;
  reason?: string;
  partnered?: { state: ListState; rows: number; matches: number };
  page?: string;
  siteSelects?: ({ name: string } & SiteSelectFlags)[];
  /** Masked page structure. */
  probe?: string[];
}

/** Logs in and reads the ad-link page of the first joined program that mentions the keyword. Changes nothing. */
export async function runA8LinkProbe(env: NodeJS.ProcessEnv): Promise<LinkProbeReport> {
  const keyword = env.A8_PROGRAM_KEYWORD?.trim();
  if (!keyword || keyword.length > KEYWORD_MAX_LENGTH) {
    throw new Error(`A8_PROGRAM_KEYWORD must be 1-${KEYWORD_MAX_LENGTH} characters`);
  }
  const siteName = env.A8_SITE_NAME?.trim() || "総額比較";
  const { login, value } = await withA8Session(env, async (page): Promise<LinkProbeReport> => {
    const list = await readListPage(page, "partnered", 1);
    const state = listState({ rows: list.rows.length, noDataShown: list.noDataShown });
    const matches = list.rows.filter((row) => row.text.includes(keyword) && pickCreateLinkPath(row) !== undefined);
    const partnered = { state, rows: list.rows.length, matches: matches.length };
    if (state === "unrecognized") return { outcome: "unrecognized", reason: "the joined-programs page was not understood", partnered };
    const target = matches[0] && pickCreateLinkPath(matches[0]);
    if (!target) return { outcome: "not_found", reason: "no joined program with an ad-link page mentions the keyword", partnered };

    await openProgramPage(page, target);
    const details = (await page.evaluate(READ_PAGE_DETAILS)) as DetailsRead;
    const tree = (await page.evaluate(DUMP_TREE)) as ProbeNode;
    return {
      outcome: "ok",
      partnered,
      page: hrefShape(page.url()),
      siteSelects: details.selects.map((select) => ({ name: select.name, ...siteSelectFlags(select.options, siteName) })),
      probe: renderProbe(tree, { redact: [keyword, siteName] }),
    };
  });
  return value ? value : { outcome: "login_failed", login };
}
