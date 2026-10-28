import type { Page } from "playwright";
import { CONSOLE_ORIGIN, safePath, withA8Session, type A8SmokeResult } from "./a8-login.js";
import {
  DUMP_TREE,
  hrefShape,
  listState,
  programIdOf,
  readRowsWhenLoaded,
  renderProbe,
  settlePage,
  type ListPage,
  type ListState,
  type ProbeNode,
  type RawProgramRow,
} from "./a8-programs.js";

/**
 * Read-only look at one advertiser program: the search results, its detail page and the page
 * with the application form. Nothing is submitted. A8's conditions are member-only and the
 * log is public, so the page text is reduced to a fixed list of yes/no flags and the page
 * structure is printed with every piece of content masked.
 */

const SEARCH_TOP_PATH = "/program/search/top";
const KEYWORD_FIELD = "#headerKeywordSearchForm input[name=keywords]";
const NAVIGATION_TIMEOUT_MS = 30_000;
const KEYWORD_MAX_LENGTH = 40;
/** Pages that do something rather than show something. A link to one is never followed. */
const ACTION_WORDING = /(execute|exec|complete|submit|register|regist|delete|remove|cancel|update|logout|confirm|post|save)/i;

export interface ConditionFlags {
  /** The program asks for the published page's URL to be submitted. */
  urlSubmission: boolean;
  reviewMentioned: boolean;
  /** Instant approval, or no review. */
  instantApproval: boolean;
  /** A notice about the affiliate applying or buying for themselves. */
  selfPurchaseNotice: boolean;
  comparisonMentioned: boolean;
  /** Search-ad (listing / PPC) wording. */
  listingAdMentioned: boolean;
}

/** Yes/no answers from a fixed list of wordings. The text itself is dropped. */
export function conditionFlags(text: string): ConditionFlags {
  return {
    urlSubmission: /(掲載|公開)(後)?(の)?URL|URL(の)?(提出|申請|登録|報告|届出)|広告掲載URL/.test(text),
    reviewMentioned: /審査/.test(text),
    instantApproval: /即時提携|自動提携|自動承認|審査(は)?(ありません|なし|不要)/.test(text),
    selfPurchaseNotice: /自己(申込|購入|契約|アフィリエイト)|ご自身(で)?の?(申込|購入|契約)|本人(申込|購入)/.test(text),
    comparisonMentioned: /比較(サイト|記事|ランキング|メディア)/.test(text),
    listingAdMentioned: /リスティング|PPC|検索連動/.test(text),
  };
}

function consoleUrl(target: string): URL | undefined {
  if (!target || /%2e|\.\./i.test(target)) return undefined;
  try {
    const url = new URL(target, CONSOLE_ORIGIN);
    return url.origin === CONSOLE_ORIGIN ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a link taken from a page may be opened: the console's own /program/ pages only,
 * never a path that sounds like an action. Page content is untrusted, so it picks nothing else.
 */
export function isProgramPagePath(target: string): boolean {
  const url = consoleUrl(target);
  return url !== undefined && url.pathname.startsWith("/program/") && !ACTION_WORDING.test(url.pathname);
}

/** The page that shows the application form (not the step that sends it). */
export function isApplyEntryPath(target: string): boolean {
  const url = consoleUrl(target);
  return isProgramPagePath(target) && url !== undefined && /^\/program\/apply(\/|$)/.test(url.pathname);
}

/** The row's own detail page, as a path and query. */
export function pickDetailPath(row: RawProgramRow): string | undefined {
  for (const href of row.hrefs) {
    const url = consoleUrl(href);
    if (!url || !isProgramPagePath(href)) continue;
    if (/^\/program\/detail/.test(url.pathname) && programIdOf(url.search) === row.programId) {
      return `${url.pathname}${url.search}`;
    }
  }
  return undefined;
}

export interface SiteOption {
  text: string;
  selected: boolean;
}

export interface SiteSelectFlags {
  count: number;
  /** The target site is one of the options. */
  hasTarget: boolean;
  /** The target site is already chosen, so nothing has to be changed. */
  defaultIsTarget: boolean;
}

/** What a site selector offers, as flags. The option names are the account's, so they are not returned. */
export function siteSelectFlags(options: readonly SiteOption[], target: string): SiteSelectFlags {
  const chosen = options.find((option) => option.selected);
  return {
    count: options.length,
    hasTarget: options.some((option) => option.text.includes(target)),
    defaultIsTarget: chosen?.text.includes(target) ?? false,
  };
}

interface PageDetails {
  text: string;
  selects: { name: string; options: SiteOption[] }[];
  links: { href: string; text: string }[];
}

/** Runs in the page. A string, because this project's TypeScript config has no DOM types. */
export const READ_PAGE_DETAILS = `(() => {
  const root = document.querySelector("main") || document.body;
  const selects = Array.from(root.querySelectorAll("select"))
    .filter((select) => /site/i.test(select.getAttribute("name") || ""))
    .map((select) => ({
      name: select.getAttribute("name") || "",
      options: Array.from(select.options).map((option) => ({ text: (option.textContent || "").trim(), selected: option.selected })),
    }));
  const links = Array.from(root.querySelectorAll("a[href]")).slice(0, 200).map((anchor) => ({
    href: anchor.getAttribute("href") || "",
    text: (anchor.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40),
  }));
  return { text: root.innerText || "", selects, links };
})()`;

export interface PageInspection {
  /** Where the page is, with ids and query values replaced. */
  page: string;
  flags: ConditionFlags;
  siteSelects: ({ name: string } & SiteSelectFlags)[];
  /** Whether the page has a link to the application form. */
  linksToApplyForm: boolean;
}

export interface InspectReport {
  outcome: "ok" | "login_failed" | "not_found" | "unrecognized";
  login?: A8SmokeResult;
  reason?: string;
  search?: { state: ListState; results: number; matches: number; attempts: 1 | 2 };
  detail?: PageInspection;
  apply?: PageInspection;
  /** Masked page structure, by page. */
  probe?: Partial<Record<"search" | "detail" | "apply", string[]>>;
}

interface Inspection {
  summary: PageInspection;
  applyEntry?: string;
  probe: string[];
}

async function inspectPage(page: Page, keyword: string, siteName: string): Promise<Inspection> {
  const details = (await page.evaluate(READ_PAGE_DETAILS)) as PageDetails;
  const applyEntry = details.links.find((link) => link.text.includes("提携申請") && isApplyEntryPath(link.href))?.href;
  const tree = (await page.evaluate(DUMP_TREE)) as ProbeNode;
  return {
    summary: {
      page: hrefShape(page.url()),
      flags: conditionFlags(details.text),
      siteSelects: details.selects.map((select) => ({ name: select.name, ...siteSelectFlags(select.options, siteName) })),
      linksToApplyForm: applyEntry !== undefined,
    },
    ...(applyEntry ? { applyEntry } : {}),
    probe: renderProbe(tree, { redact: [keyword] }),
  };
}

export async function openProgramPage(page: Page, target: string): Promise<void> {
  if (!isProgramPagePath(target)) throw new Error(`refusing to open ${hrefShape(target)}`);
  await page.goto(`${CONSOLE_ORIGIN}${target}`, { waitUntil: "domcontentloaded" });
  await settlePage(page);
}

const SEARCH_FORM = "form[name=asSearchForm]";
const SEARCH_FORM_FIELD = `${SEARCH_FORM} input[name=keywordBox]`;
const SEARCH_FORM_BUTTON = `${SEARCH_FORM} .searchAction button[type=submit]`;
const SECOND_SEARCH_NAVIGATION_MS = 8_000;

export interface SearchResult extends ListPage {
  /** 1 when the header search was enough, 2 when the search page's own form had to be used. */
  attempts: 1 | 2;
  probe: string[];
}

export async function searchFor(page: Page, keyword: string): Promise<SearchResult> {
  await openProgramPage(page, SEARCH_TOP_PATH);
  await page.fill(KEYWORD_FIELD, keyword);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }),
    page.press(KEYWORD_FIELD, "Enter"),
  ]);
  if (!safePath(page.url()).startsWith("/program/search")) {
    throw new Error(`the search led to ${safePath(page.url())}`);
  }
  let read = await readRowsWhenLoaded(page);
  let attempts: 1 | 2 = 1;
  if (read.rows.length === 0 && (await page.locator(SEARCH_FORM_FIELD).count()) > 0) {
    // The header search may only open the search page; use the form on that page.
    attempts = 2;
    await page.fill(SEARCH_FORM_FIELD, keyword);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: SECOND_SEARCH_NAVIGATION_MS }).catch(() => undefined),
      page.click(SEARCH_FORM_BUTTON),
    ]);
    read = await readRowsWhenLoaded(page);
  }
  const tree = (await page.evaluate(DUMP_TREE)) as ProbeNode;
  return { ...read, attempts, probe: renderProbe(tree, { redact: [keyword] }) };
}

async function inspectProgram(page: Page, keyword: string, siteName: string): Promise<Omit<InspectReport, "login">> {
  const search = await searchFor(page, keyword);
  const state = listState({ rows: search.rows.length, noDataShown: search.noDataShown });
  const matches = search.rows.filter((row) => row.text.includes(keyword));
  const summary = { state, results: search.rows.length, matches: matches.length, attempts: search.attempts };
  const probe: NonNullable<InspectReport["probe"]> = { search: search.probe };
  if (state === "unrecognized") return { outcome: "unrecognized", reason: "the search results page was not understood", search: summary, probe };
  const first = matches[0];
  if (!first) return { outcome: "not_found", reason: "no search result mentions the keyword", search: summary, probe };
  const detailPath = pickDetailPath(first);
  if (!detailPath) return { outcome: "unrecognized", reason: "the matching result has no detail link", search: summary, probe };

  await openProgramPage(page, detailPath);
  const detail = await inspectPage(page, keyword, siteName);
  probe.detail = detail.probe;
  if (!detail.applyEntry) return { outcome: "ok", search: summary, detail: detail.summary, probe };

  await openProgramPage(page, detail.applyEntry);
  const apply = await inspectPage(page, keyword, siteName);
  probe.apply = apply.probe;
  return { outcome: "ok", search: summary, detail: detail.summary, apply: apply.summary, probe };
}

/** Logs in and looks at one program's search result, detail and application pages. Submits nothing. */
export async function runA8Inspect(env: NodeJS.ProcessEnv): Promise<InspectReport> {
  const keyword = env.A8_PROGRAM_KEYWORD?.trim();
  if (!keyword || keyword.length > KEYWORD_MAX_LENGTH) {
    throw new Error(`A8_PROGRAM_KEYWORD must be 1-${KEYWORD_MAX_LENGTH} characters`);
  }
  const siteName = env.A8_SITE_NAME?.trim() || "総額比較";
  const { login, value } = await withA8Session(env, (page) => inspectProgram(page, keyword, siteName));
  return value ? value : { outcome: "login_failed", login };
}
