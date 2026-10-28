import type { Page } from "playwright";
import { CONSOLE_ORIGIN, withA8Session, type A8SmokeResult } from "./a8-login.js";
import { openProgramPage, pickDetailPath, searchFor } from "./a8-inspect.js";
import {
  DUMP_TREE,
  hrefShape,
  listState,
  renderProbe,
  settlePage,
  type ListState,
  type ProbeNode,
} from "./a8-programs.js";

/**
 * The first step of applying to one advertiser program (提携申請): choose the target site in
 * the form on the program's detail page and press the button that leads on. It stops on the page
 * that comes next and prints that page's structure, so the following step can be built from
 * what is really there. It never presses anything on that next page.
 *
 * The program and the account are member-only information and the log is public, so only
 * counts, flags and the masked page structure are printed.
 */

const APPLY_STEP_PATH = "/program/agreement/apply";
const SITE_SELECT = "select[name=webSiteId]";
const APPLY_FORM = `form[action$="${APPLY_STEP_PATH}"]`;
const APPLY_BUTTON = `${APPLY_FORM} button[type=submit]`;
const NAVIGATION_TIMEOUT_MS = 30_000;
const KEYWORD_MAX_LENGTH = 40;

export interface ApplySiteOption {
  value: string;
  text: string;
  selected: boolean;
}

/**
 * The option that names the target site, only when exactly one does and it has a value to send.
 * Anything else is "no answer": applying under the account's first site by default is the
 * mistake this guards against.
 */
export function chooseSiteOption(options: readonly ApplySiteOption[], target: string): { value: string } | undefined {
  const wanted = target.trim();
  if (!wanted) return undefined;
  const named = options.filter((option) => option.text.includes(wanted));
  const only = named.length === 1 ? named[0] : undefined;
  return only && only.value ? { value: only.value } : undefined;
}

/** The form that applies to a single program, and nothing else (not the bulk application). */
export function isApplyFormAction(action: string): boolean {
  if (!action || /%2e|\.\./i.test(action)) return false;
  try {
    const url = new URL(action, CONSOLE_ORIGIN);
    return url.origin === CONSOLE_ORIGIN && url.pathname === APPLY_STEP_PATH;
  } catch {
    return false;
  }
}

/** The detail page of a program the account has not joined yet, which is the one with the form. */
export function isNotPartneredDetail(target: string): boolean {
  if (!target || /%2e|\.\./i.test(target)) return false;
  try {
    const url = new URL(target, CONSOLE_ORIGIN);
    return url.origin === CONSOLE_ORIGIN && url.pathname === "/program/detail-not-partnered";
  } catch {
    return false;
  }
}

export type HiddenSiteState = "empty" | "same" | "different";

/** Whether the form's own copy of the site agrees with the choice made in the selector. */
export function hiddenSiteState(hidden: string, chosen: string): HiddenSiteState {
  if (!hidden) return "empty";
  return hidden === chosen ? "same" : "different";
}

interface ApplyFormState {
  formAction: string;
  options: ApplySiteOption[];
  hidden: string;
  buttons: number;
}

/** Runs in the page. A string, because this project's TypeScript config has no DOM types. */
export const READ_APPLY_FORM = `(() => {
  const form = Array.from(document.querySelectorAll("form")).find((candidate) =>
    /\\/program\\/agreement\\/apply$/.test((candidate.getAttribute("action") || "").split("?")[0]));
  const select = document.querySelector("select[name=webSiteId]");
  const hidden = form ? form.querySelector("input[name=webSiteId]") : null;
  return {
    formAction: form ? form.getAttribute("action") || "" : "",
    options: select
      ? Array.from(select.options).map((option) => ({
          value: option.value,
          text: (option.textContent || "").trim(),
          selected: option.selected,
        }))
      : [],
    hidden: hidden ? hidden.value || "" : "",
    buttons: form ? form.querySelectorAll("button[type=submit]").length : 0,
  };
})()`;

interface ReachedPage {
  text: string;
  checkboxes: number;
  submitButtons: number;
}

/** Runs in the page. Counts controls and returns the text only so the caller can look for the site. */
const READ_REACHED_PAGE = `(() => {
  const root = document.querySelector("main") || document.body;
  return {
    text: root.innerText || "",
    checkboxes: root.querySelectorAll("input[type=checkbox]").length,
    submitButtons: root.querySelectorAll("button[type=submit], input[type=submit]").length,
  };
})()`;

export interface ApplyReport {
  outcome: "reached" | "login_failed" | "not_found" | "unrecognized" | "refused";
  login?: A8SmokeResult;
  reason?: string;
  search?: { state: ListState; results: number; matches: number };
  /** The site chosen in the selector and whether the form's own copy agreed. */
  site?: { chosen: boolean; hidden: HiddenSiteState };
  /** The page the button led to. */
  reached?: { page: string; siteShown: boolean; checkboxes: number; submitButtons: number };
  /** Masked structure of the page reached. */
  probe?: string[];
}

function refused(reason: string, extra: Partial<ApplyReport> = {}): ApplyReport {
  return { outcome: "refused", reason, ...extra };
}

async function startApplication(page: Page, keyword: string, siteName: string): Promise<ApplyReport> {
  const search = await searchFor(page, keyword);
  const state = listState({ rows: search.rows.length, noDataShown: search.noDataShown });
  const matches = search.rows.filter((row) => row.text.includes(keyword));
  const summary = { state, results: search.rows.length, matches: matches.length };
  if (state === "unrecognized") return { outcome: "unrecognized", reason: "the search results page was not understood", search: summary };
  const first = matches[0];
  if (!first) return { outcome: "not_found", reason: "no search result mentions the keyword", search: summary };
  const detailPath = pickDetailPath(first);
  if (!detailPath) return { outcome: "unrecognized", reason: "the matching result has no detail link", search: summary };
  if (!isNotPartneredDetail(detailPath)) return refused("the program is already joined or has no application form", { search: summary });

  await openProgramPage(page, detailPath);
  const form = (await page.evaluate(READ_APPLY_FORM)) as ApplyFormState;
  if (!isApplyFormAction(form.formAction) || form.buttons !== 1) return refused("the application form was not found", { search: summary });
  const site = chooseSiteOption(form.options, siteName);
  if (!site) return refused("the target site is not exactly one of the selector's options", { search: summary });

  await page.selectOption(SITE_SELECT, site.value);
  const after = (await page.evaluate(READ_APPLY_FORM)) as ApplyFormState;
  const chosen = after.options.find((option) => option.selected)?.value === site.value;
  const hidden = hiddenSiteState(after.hidden, site.value);
  const siteReport = { chosen, hidden };
  if (!chosen || hidden === "different") return refused("the target site could not be chosen", { search: summary, site: siteReport });
  if ((await page.locator(APPLY_BUTTON).count()) !== 1) return refused("the application button was not found", { search: summary, site: siteReport });

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }),
    page.click(APPLY_BUTTON),
  ]);
  await settlePage(page);
  const reached = (await page.evaluate(READ_REACHED_PAGE)) as ReachedPage;
  const tree = (await page.evaluate(DUMP_TREE)) as ProbeNode;
  return {
    outcome: "reached",
    search: summary,
    site: siteReport,
    reached: {
      page: hrefShape(page.url()),
      siteShown: reached.text.includes(siteName),
      checkboxes: reached.checkboxes,
      submitButtons: reached.submitButtons,
    },
    probe: renderProbe(tree, { redact: [keyword, siteName] }),
  };
}

/** Logs in, chooses the target site in one program's application form and presses the first button. */
export async function runA8Apply(env: NodeJS.ProcessEnv): Promise<ApplyReport> {
  const keyword = env.A8_PROGRAM_KEYWORD?.trim();
  if (!keyword || keyword.length > KEYWORD_MAX_LENGTH) {
    throw new Error(`A8_PROGRAM_KEYWORD must be 1-${KEYWORD_MAX_LENGTH} characters`);
  }
  const siteName = env.A8_SITE_NAME?.trim();
  if (!siteName) throw new Error("A8_SITE_NAME is required: the application must name the site");
  const { login, value } = await withA8Session(env, (page) => startApplication(page, keyword, siteName));
  return value ? value : { outcome: "login_failed", login };
}
