import type { Locator, Page } from "playwright";
import { CONSOLE_ORIGIN, withA8Session, type A8SmokeResult } from "./a8-login.js";
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
const POPUP_WAIT_MS = 4_000;

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** The card whose program name mentions the keyword, then its ad-URL button. */
export function adUrlButtonLocator(page: Page, keyword: string): Locator {
  return page
    .locator(".pgCard")
    .filter({ has: page.locator(".pgName", { hasText: keyword }) })
    .locator(".actionAdurl");
}

/** Runs in the page: remembers, for every element, whether it is on screen now. Run before the click. */
export const MARK_SEEN = `(() => {
  for (const element of document.querySelectorAll("*")) {
    element.setAttribute("data-probe-seen", element.getClientRects().length > 0 ? "v" : "h");
  }
})()`;

/** Elements on screen now that were not there before the click (new, or hidden before), outermost only. */
const CHANGED_ROOTS = `(() => {
  const onScreen = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const changed = Array.from(document.querySelectorAll("*")).filter((element) => {
    const mark = element.getAttribute("data-probe-seen");
    return onScreen(element) && (mark === null || mark === "h");
  });
  const set = new Set(changed);
  return changed.filter((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) if (set.has(parent)) return false;
    return true;
  });
})()`;

/**
 * Runs in the page after the click: how many outermost elements appeared, and the masked tree of the
 * one with the most controls (a dialog, a panel); the page's main content when nothing appeared.
 */
export const DUMP_CHANGES_OR_MAIN = `({
  changed: (${CHANGED_ROOTS}).length,
  tree: ${dumpTreeScript(`(() => {
    const roots = ${CHANGED_ROOTS};
    const controls = (element) => element.querySelectorAll("input, select, textarea, button").length;
    roots.sort((a, b) => controls(b) - controls(a));
    return roots[0] || document.querySelector("main") || document.body;
  })()`)},
})`;

export interface AdUrlProbeReport {
  outcome: "ok" | "login_failed" | "not_found" | "unrecognized";
  login?: A8SmokeResult;
  reason?: string;
  partnered?: { state: ListState; buttons: number };
  /** Where the click led, as a path shape; the same as the list's when only a panel opened. */
  after?: { page: string; navigated: boolean; popup: boolean; changed: number };
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

    await page.evaluate(MARK_SEEN);
    const before = page.url();
    // The button may open the management page in a new tab, or a panel on this page.
    const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: POPUP_WAIT_MS }).catch(() => undefined), button.click()]);
    const target = popup ?? page;
    if (popup) await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
    await settlePage(target);
    if (popup && safeOrigin(popup.url()) !== CONSOLE_ORIGIN) {
      return { outcome: "unrecognized", reason: "the button opened a page outside the console", partnered, after: { page: hrefShape(popup.url()), navigated: false, popup: true, changed: 0 } };
    }
    const { changed, tree } = (await target.evaluate(DUMP_CHANGES_OR_MAIN)) as { changed: number; tree: ProbeNode };
    return {
      outcome: "ok",
      partnered,
      after: { page: hrefShape(target.url()), navigated: target.url() !== before, popup: popup !== undefined, changed },
      probe: renderProbe(tree, { redact: [keyword, siteName] }),
    };
  });
  return value ? value : { outcome: "login_failed", login };
}
