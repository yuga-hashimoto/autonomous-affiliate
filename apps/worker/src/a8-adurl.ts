import type { Locator, Page } from "playwright";
import { withA8Session, type A8SmokeResult } from "./a8-login.js";
import {
  dumpTreeScript,
  hrefShape,
  listState,
  readListPage,
  renderProbe,
  settlePage,
  type ListState,
  type ProbeNode,
} from "./a8-programs.js";

/**
 * Read-only look at what a joined program's ad-URL button (広告掲載URL管理) opens. The button is a
 * script link on the program's card in the joined list. One click opens the page or dialog where the
 * URLs that carry the program's ads are managed; nothing inside it is pressed or filled. Its structure
 * is printed with every piece of content masked, so a later step can register article URLs from what
 * is really there. The log is public: no URL, id or program text goes in it.
 */

const KEYWORD_MAX_LENGTH = 40;

/** The card whose program name mentions the keyword, then its ad-URL button. */
export function adUrlButtonLocator(page: Page, keyword: string): Locator {
  return page
    .locator(".pgCard")
    .filter({ has: page.locator(".pgName", { hasText: keyword }) })
    .locator(".actionAdurl");
}

/** Runs in the page: the visible dialog with the most controls if one is open, else the page's main content. */
export const DUMP_DIALOG_OR_MAIN = dumpTreeScript(`(() => {
  const candidates = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, [class*="modal" i], [class*="dialog" i]'))
    .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
  const controls = (element) => element.querySelectorAll("input, select, textarea, button").length;
  candidates.sort((a, b) => controls(b) - controls(a));
  return candidates[0] || document.querySelector("main") || document.body;
})()`);

export interface AdUrlProbeReport {
  outcome: "ok" | "login_failed" | "not_found" | "unrecognized";
  login?: A8SmokeResult;
  reason?: string;
  partnered?: { state: ListState; buttons: number };
  /** Where the click led, as a path shape; the same as the list's when only a dialog opened. */
  after?: { page: string; navigated: boolean };
  /** Masked structure of the dialog or page the button opened. */
  probe?: string[];
}

/** Logs in and opens the ad-URL management of the joined program that mentions the keyword. Changes nothing. */
export async function runA8AdUrlProbe(env: NodeJS.ProcessEnv): Promise<AdUrlProbeReport> {
  const keyword = env.A8_PROGRAM_KEYWORD?.trim();
  if (!keyword || keyword.length > KEYWORD_MAX_LENGTH) {
    throw new Error(`A8_PROGRAM_KEYWORD must be 1-${KEYWORD_MAX_LENGTH} characters`);
  }
  const siteName = env.A8_SITE_NAME?.trim() || "総額比較";
  const { login, value } = await withA8Session(env, async (page): Promise<AdUrlProbeReport> => {
    const list = await readListPage(page, "partnered", 1);
    const state = listState({ rows: list.rows.length, noDataShown: list.noDataShown });
    if (state === "unrecognized") return { outcome: "unrecognized", reason: "the joined-programs page was not understood", partnered: { state, buttons: 0 } };
    const button = adUrlButtonLocator(page, keyword);
    const buttons = await button.count();
    const partnered = { state, buttons };
    if (buttons !== 1) return { outcome: "not_found", reason: "no single ad-URL button on a joined program's card", partnered };

    const before = page.url();
    await button.click();
    await settlePage(page);
    const tree = (await page.evaluate(DUMP_DIALOG_OR_MAIN)) as ProbeNode;
    return {
      outcome: "ok",
      partnered,
      after: { page: hrefShape(page.url()), navigated: page.url() !== before },
      probe: renderProbe(tree, { redact: [keyword, siteName] }),
    };
  });
  return value ? value : { outcome: "login_failed", login };
}
