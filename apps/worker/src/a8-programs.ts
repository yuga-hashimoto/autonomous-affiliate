import type { Page } from "playwright";
import { CONSOLE_ORIGIN, safePath, withA8Session, type A8SmokeResult } from "./a8-login.js";

/**
 * Read-only look at the A8 console's partnered-programs list.
 *
 * What A8 shows about programs (names, conditions, rewards) is member-only and
 * this repository and its Actions logs are public. So this module returns and
 * prints only counts by status. The optional probe prints the page's structure
 * with every piece of content masked, to learn what the console looks like.
 */

const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const PROBE_MAX_LINES = 600;
const PROBE_LABEL_MAX = 40;
const PROBE_SHORT_TEXT_MAX = 12;
const PROGRAM_ID = /^[A-Za-z0-9]{3,40}$/;

/** The console's program lists. Where a program is listed says what its approval state is. */
export const PROGRAM_LISTS = {
  partnered: { path: "/program/list/partnered", status: "approved" },
  applying: { path: "/program/list/applying", status: "pending" },
  terminated: { path: "/program/list/terminated", status: "ended" },
  canceled: { path: "/program/list/canceled", status: "ended" },
} as const;
export type ListKind = keyof typeof PROGRAM_LISTS;
const LIST_KINDS = Object.keys(PROGRAM_LISTS) as ListKind[];

export type ProgramStatus = "approved" | "pending" | "rejected" | "ended" | "unknown";

export interface RawProgramRow {
  programId: string;
  /** The program's name, when the page shows it separately. Used to pick a vertical, then dropped. */
  name?: string;
  /** Visible text of the row. Used to decide the status, then dropped. */
  text: string;
  hrefs: string[];
}

export interface PartneredProgram {
  programId: string;
  status: ProgramStatus;
  /** Which vertical the program's name belongs to ("other" when none). The name itself is not kept. */
  vertical: string;
  /** The row links to the page that makes ad links. */
  hasAdLinkPage: boolean;
}

export interface ProgramSummary {
  total: number;
  approved: number;
  pending: number;
  rejected: number;
  ended: number;
  unknown: number;
  withAdLinkPage: number;
  /** Approved programs per vertical, so the kind of program is known without printing any name. */
  approvedByVertical: Record<string, number>;
}

export function isProgramId(id: string): boolean {
  return PROGRAM_ID.test(id);
}

export function programIdOf(href: string): string | undefined {
  const match = /[?&]programId=([^&#]*)/.exec(href);
  const id = match?.[1];
  return id !== undefined && PROGRAM_ID.test(id) ? id : undefined;
}

/** A link reduced to where it goes: path and query keys, no values, no ids, nothing about outside sites. */
export function hrefShape(href: string): string {
  const raw = href.trim();
  if (!raw) return "(none)";
  if (/^javascript:/i.test(raw)) return "(script)";
  if (raw.startsWith("#")) return "#";
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) {
    let url: URL;
    try {
      url = new URL(raw, CONSOLE_ORIGIN);
    } catch {
      return "(external)";
    }
    if (url.origin !== CONSOLE_ORIGIN) return "(external)";
    return shapeOf(url.pathname, url.search);
  }
  const [path = "", ...rest] = raw.split("?");
  return shapeOf(path, rest.length > 0 ? `?${rest.join("?")}` : "");
}

function shapeOf(path: string, search: string): string {
  const segments = path.split("/").map((segment) => (/^[A-Za-z]?\d{6,}$/.test(segment) ? ":id" : segment));
  const keys = search
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => pair.length > 0)
    .map((pair) => `${pair.split("=")[0] ?? ""}=*`);
  return `${segments.join("/")}${keys.length > 0 ? `?${keys.join("&")}` : ""}`;
}

/**
 * Which vertical (docs/01) a program name belongs to, by public vocabulary. The first rule that
 * matches wins, so the specific ones come first (a car buyback is not a general buyback).
 */
const VERTICAL_RULES: readonly (readonly [string, RegExp])[] = [
  ["car_buyback", /車(買取|買い取り|査定)|自動車.*(買取|査定)|廃車/],
  ["water_delivery", /ウォーターサーバー|宅配水|天然水|ミネラルウォーター|水の宅配|ウォーター/],
  ["moving", /引越|引っ越し/],
  ["fiber", /光回線|光コラボ|ホームルーター|WiMAX|ワイマックス|Wi-?Fi|ネット回線|インターネット接続|フレッツ|ひかり/i],
  ["mobile", /SIM|モバイル|スマホ|スマートフォン|携帯/i],
  ["utilities", /電力|電気|都市ガス|ガス会社/],
  ["buyback", /買取|買い取り|査定/],
  ["education", /スクール|講座|資格|学習|英会話|プログラミング|通信教育|教室/],
  ["career", /転職|求人|派遣|就職|看護師|キャリア|エージェント/],
  ["saas", /クラウド|SaaS|会計|ソフト|ツール|システム|サーバー/i],
];
const NAME_FALLBACK_LENGTH = 120;

export function verticalOf(name: string): string {
  return VERTICAL_RULES.find(([, pattern]) => pattern.test(name))?.[0] ?? "other";
}

const ENDED = /プログラム終了|提携解除|提携終了|提携停止|掲載終了|掲載停止|配信停止|募集終了|停止中/;
const REJECTED = /却下|否認|不承認|提携不可/;
const PENDING = /申請中|審査中/;

/**
 * Decides a row's status. Wording that says "over" wins over a link to the ad-link
 * page, so a program that ended is never treated as usable; with neither wording
 * nor an ad-link page, the answer is unknown, which callers must treat as not approved.
 */
export function classifyProgramStatus(text: string, hrefs: readonly string[]): ProgramStatus {
  if (ENDED.test(text)) return "ended";
  if (REJECTED.test(text)) return "rejected";
  if (PENDING.test(text)) return "pending";
  return hrefs.some((href) => /\/create-link(\?|$)/.test(href)) ? "approved" : "unknown";
}

/**
 * A program's status from the list it was found in, unless its wording says it is over or
 * refused. Only the partnered list needs more than the list: a row there counts as approved
 * only when it links to the ad-link page, otherwise it is unknown (not approved).
 */
export function statusInList(list: ListKind, text: string, hrefs: readonly string[]): ProgramStatus {
  const byWording = classifyProgramStatus(text, hrefs);
  if (byWording === "ended" || byWording === "rejected") return byWording;
  if (list === "partnered") return byWording === "approved" || byWording === "pending" ? byWording : "unknown";
  return PROGRAM_LISTS[list].status;
}

export type ListState = "programs" | "empty" | "unrecognized";

/** An empty list shows a "no data" area; a page with neither rows nor that area is not understood. */
export function listState(page: { rows: number; noDataShown: boolean }): ListState {
  if (page.rows > 0) return "programs";
  return page.noDataShown ? "empty" : "unrecognized";
}

export function parseProgramRows(rows: readonly RawProgramRow[], list: ListKind = "partnered"): PartneredProgram[] {
  const seen = new Set<string>();
  const programs: PartneredProgram[] = [];
  for (const row of rows) {
    if (!PROGRAM_ID.test(row.programId) || seen.has(row.programId)) continue;
    seen.add(row.programId);
    programs.push({
      programId: row.programId,
      status: statusInList(list, row.text, row.hrefs),
      vertical: verticalOf(row.name?.trim() || row.text.slice(0, NAME_FALLBACK_LENGTH)),
      hasAdLinkPage: row.hrefs.some((href) => /\/create-link(\?|$)/.test(href) && programIdOf(href) === row.programId),
    });
  }
  return programs;
}

export function summarizePrograms(programs: readonly PartneredProgram[]): ProgramSummary {
  const count = (status: ProgramStatus): number => programs.filter((program) => program.status === status).length;
  return {
    total: programs.length,
    approved: count("approved"),
    pending: count("pending"),
    rejected: count("rejected"),
    ended: count("ended"),
    unknown: count("unknown"),
    withAdLinkPage: programs.filter((program) => program.hasAdLinkPage).length,
    approvedByVertical: programs
      .filter((program) => program.status === "approved")
      .reduce<Record<string, number>>((counts, program) => ({ ...counts, [program.vertical]: (counts[program.vertical] ?? 0) + 1 }), {}),
  };
}

export interface ProbeNode {
  tag: string;
  cls: string[];
  id?: string;
  name?: string;
  type?: string;
  /** A link's target, or a form's action. */
  href?: string;
  /** A form's method. */
  method?: string;
  /** The element's own text, not its children's. */
  text: string;
  children: ProbeNode[];
}

/** Tags whose short text is shown outside a program row: menu items and buttons, not values. */
const SHORT_TEXT_TAGS = new Set(["a", "li", "button"]);
/** Tags whose text is interface wording (column headings, buttons, form labels, terms), never page data. */
const LABEL_TAGS = new Set(["th", "dt", "button", "label", "option"]);
/** Headings are labels too, but one inside a program's card is its name, and a long one could be a name, so: never in a card, and a shorter limit elsewhere. */
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "caption", "summary", "legend"]);
const PROBE_HEADING_MAX = 20;
/** A select with this in its name lists the account's own sites; those names are account details. */
const SITE_SELECT = /site/i;
/** The only words printed from masked text, so a status vocabulary can be learned. */
const STATUS_WORDS = [
  "提携申請中",
  "提携中",
  "提携不可",
  "提携解除",
  "提携終了",
  "プログラム終了",
  "掲載停止",
  "申請中",
  "審査中",
  "参加中",
  "承認",
  "却下",
  "否認",
  "保留",
  "停止中",
];

function idsIn(node: ProbeNode, memo: Map<ProbeNode, Set<string>>): Set<string> {
  const ids = new Set<string>();
  const own = node.href ? programIdOf(node.href) : undefined;
  if (own) ids.add(own);
  for (const child of node.children) for (const id of idsIn(child, memo)) ids.add(id);
  memo.set(node, ids);
  return ids;
}

function statusWordsIn(text: string): string {
  const found = STATUS_WORDS.filter((word) => text.includes(word));
  return found.length > 0 ? ` ≈[${found.join(",")}]` : "";
}

interface DescribeContext {
  /** Inside a select of the account's sites: option text is not printed. */
  maskOptions: boolean;
}

function describeNode(node: ProbeNode, masked: boolean, context: DescribeContext): string {
  const parts: string[] = [node.tag];
  if (node.id) parts.push(`#${node.id}`);
  if (node.cls.length > 0) parts.push(`.${node.cls.slice(0, 3).join(".")}`);
  const attributes = [
    node.name ? `name=${node.name}` : "",
    node.type ? `type=${node.type}` : "",
    node.method ? `method=${node.method.toLowerCase()}` : "",
  ].filter(Boolean);
  if (attributes.length > 0) parts.push(` [${attributes.join(" ")}]`);
  if (node.href !== undefined) parts.push(` -> ${hrefShape(node.href)}`);
  const text = node.text.trim();
  if (text) {
    const isLabel =
      (LABEL_TAGS.has(node.tag) && text.length <= PROBE_LABEL_MAX && !(node.tag === "option" && context.maskOptions)) ||
      (HEADING_TAGS.has(node.tag) && text.length <= PROBE_HEADING_MAX && !masked);
    const isShortOutsideRows = !masked && SHORT_TEXT_TAGS.has(node.tag) && text.length <= PROBE_SHORT_TEXT_MAX;
    // Long digit strings (ids, numbers) are never printed, even in a label.
    parts.push(isLabel || isShortOutsideRows ? ` "${text.replace(/\d{5,}/g, "#")}"` : ` T${text.length}${statusWordsIn(text)}`);
  }
  return parts.join("");
}

export interface RenderProbeOptions {
  /** Terms that must not appear in the output, such as the program name searched for. */
  redact?: readonly string[];
}

function redactTerms(line: string, terms: readonly string[]): string {
  return terms
    .filter((term) => term.length >= 2)
    .reduce((current, term) => current.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[term]"), line);
}

/**
 * Renders a page's element tree as indented lines for a public log. Text is shown
 * only for interface labels and for short text outside a program row (a row being
 * any element that contains exactly one program's links); everything else is a length.
 * The options of a select that lists the account's sites are never shown.
 */
export function renderProbe(root: ProbeNode, options: RenderProbeOptions = {}): string[] {
  const memo = new Map<ProbeNode, Set<string>>();
  idsIn(root, memo);
  const terms = options.redact ?? [];
  const lines: string[] = [];
  let truncated = false;

  const visit = (node: ProbeNode, depth: number, insideRow: boolean, maskOptions: boolean): void => {
    if (lines.length >= PROBE_MAX_LINES) {
      truncated = true;
      return;
    }
    const masked = insideRow || node.tag === "td" || memo.get(node)?.size === 1;
    const siteSelect = maskOptions || (node.tag === "select" && SITE_SELECT.test(node.name ?? ""));
    lines.push(`${"  ".repeat(Math.min(depth, 12))}${redactTerms(describeNode(node, masked, { maskOptions: siteSelect }), terms)}`);
    for (const child of node.children) visit(child, depth + 1, masked, siteSelect);
  };
  visit(root, 0, false, false);
  if (truncated) lines.push("…(truncated)");
  return lines;
}

/** Runs in the page. A string, because this project's TypeScript config has no DOM types. */
export const READ_PROGRAM_ROWS = `(() => {
  const scope = document.querySelector("main") || document.body;
  const rows = new Map();
  for (const anchor of scope.querySelectorAll('a[href*="programId="]')) {
    const match = /[?&]programId=([A-Za-z0-9]+)/.exec(anchor.getAttribute("href") || "");
    if (!match || rows.has(match[1])) continue;
    const container = anchor.closest(".pgCard") || anchor.closest("tr, li, article") || (anchor.parentElement && anchor.parentElement.parentElement) || anchor;
    const hrefs = Array.from(container.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") || "").slice(0, 30);
    const nameElement = container.querySelector(".pgName");
    rows.set(match[1], {
      programId: match[1],
      name: nameElement ? (nameElement.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 120) : undefined,
      text: (container.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 400),
      hrefs,
    });
  }
  const noData = document.querySelector(".noDataArea");
  const noDataShown = noData !== null && noData.getClientRects().length > 0 && getComputedStyle(noData).visibility !== "hidden";
  return { rows: Array.from(rows.values()), noDataShown };
})()`;

/** Runs in the page: the element tree with only structure and own text. */
export const DUMP_TREE = `(() => {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH", "IMG", "LINK", "META"]);
  let budget = 3000;
  const walk = (element, depth) => {
    budget -= 1;
    const own = Array.from(element.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent || "")
      .join(" ")
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, 200);
    const children = [];
    if (depth < 14) {
      for (const child of element.children) {
        if (budget <= 0) break;
        if (SKIP.has(child.tagName.toUpperCase())) continue;
        children.push(walk(child, depth + 1));
      }
    }
    return {
      tag: element.tagName.toLowerCase(),
      cls: Array.from(element.classList).slice(0, 4),
      id: element.id || undefined,
      name: element.getAttribute("name") || undefined,
      type: element.getAttribute("type") || undefined,
      href: element.tagName === "A" ? element.getAttribute("href") || "" : element.tagName === "FORM" ? element.getAttribute("action") || "" : undefined,
      method: element.tagName === "FORM" ? element.getAttribute("method") || "get" : undefined,
      text: own,
      children,
    };
  };
  return walk(document.querySelector("main") || document.body, 0);
})()`;

export interface ListReport {
  state: ListState;
  pagesRead: number;
  programs: ProgramSummary;
}

export interface ProgramsReport {
  /** "unrecognized" when any list page was neither a list of programs nor an empty list. */
  outcome: "ok" | "login_failed" | "unrecognized";
  login?: A8SmokeResult;
  lists?: Record<ListKind, ListReport>;
  /** Masked structure of each list page that is not empty, by list. */
  probe?: Partial<Record<ListKind, string[]>>;
}

export interface ListPage {
  rows: RawProgramRow[];
  noDataShown: boolean;
}

const SETTLE_TIMEOUT_MS = 12_000;
const SETTLE_PAUSE_MS = 1_000;
const RECHECK_DELAY_MS = 2_000;

/**
 * The console draws most of its pages with JavaScript after the document has loaded (a loading
 * spinner shows first), so reading straight after navigation sees a page with nothing on it.
 * Wait for the network to go quiet, then a moment more.
 */
export async function settlePage(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);
  await page.waitForTimeout(SETTLE_PAUSE_MS);
}

/**
 * Reads the program rows of the current page once it has loaded. An empty answer is trusted only
 * after a second look a little later, because a "no data" message can be on screen before the data arrives.
 */
export async function readRowsWhenLoaded(page: Page): Promise<ListPage> {
  await settlePage(page);
  const first = (await page.evaluate(READ_PROGRAM_ROWS)) as ListPage;
  if (first.rows.length > 0) return first;
  await page.waitForTimeout(RECHECK_DELAY_MS);
  await settlePage(page);
  return (await page.evaluate(READ_PROGRAM_ROWS)) as ListPage;
}

export async function readListPage(page: Page, list: ListKind, pageNo: number): Promise<ListPage> {
  const { path } = PROGRAM_LISTS[list];
  const query = list === "partnered" ? "&sortKey=APPROVED_DATE&sortOrder=DESC" : "";
  await page.goto(`${CONSOLE_ORIGIN}${path}?pageNo=${pageNo}&pageSize=${PAGE_SIZE}${query}`, { waitUntil: "domcontentloaded" });
  if (safePath(page.url()) !== path) {
    throw new Error(`${path} redirected to ${safePath(page.url())}; the session is not usable`);
  }
  return readRowsWhenLoaded(page);
}

async function readList(
  page: Page,
  list: ListKind,
  probe: boolean,
): Promise<{ report: ListReport; probe?: string[] }> {
  const found = new Map<string, PartneredProgram>();
  let state: ListState = "empty";
  let probeLines: string[] | undefined;
  let pagesRead = 0;
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
    const listPage = await readListPage(page, list, pageNo);
    pagesRead = pageNo;
    const pageState = listState({ rows: listPage.rows.length, noDataShown: listPage.noDataShown });
    if (pageNo === 1) {
      state = pageState;
      // An empty list was already seen; print the structure only of pages that have something on them.
      if (probe && pageState !== "empty") probeLines = renderProbe((await page.evaluate(DUMP_TREE)) as ProbeNode);
    }
    const fresh = parseProgramRows(listPage.rows, list).filter((program) => !found.has(program.programId));
    if (fresh.length === 0) break;
    for (const program of fresh) found.set(program.programId, program);
  }
  return {
    report: { state, pagesRead, programs: summarizePrograms(Array.from(found.values())) },
    ...(probeLines ? { probe: probeLines } : {}),
  };
}

async function readAllLists(page: Page, probe: boolean): Promise<Pick<ProgramsReport, "lists" | "probe">> {
  const lists = {} as Record<ListKind, ListReport>;
  const probes: Partial<Record<ListKind, string[]>> = {};
  for (const list of LIST_KINDS) {
    const result = await readList(page, list, probe);
    lists[list] = result.report;
    if (result.probe) probes[list] = result.probe;
  }
  return { lists, ...(Object.keys(probes).length > 0 ? { probe: probes } : {}) };
}

/** Logs in, reads the program lists and returns counts by status. Changes nothing in the console. */
export async function runA8Programs(env: NodeJS.ProcessEnv): Promise<ProgramsReport> {
  const probe = env.A8_PROBE === "1";
  const { login, value } = await withA8Session(env, (page) => readAllLists(page, probe));
  if (!value?.lists) return { outcome: "login_failed", login };
  const unrecognized = LIST_KINDS.some((list) => value.lists?.[list].state === "unrecognized");
  return { outcome: unrecognized ? "unrecognized" : "ok", ...value };
}
