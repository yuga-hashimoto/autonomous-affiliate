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

const PARTNERED_PATH = "/program/list/partnered";
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const PROBE_MAX_LINES = 600;
const PROBE_LABEL_MAX = 40;
const PROBE_SHORT_TEXT_MAX = 12;
const PROGRAM_ID = /^[A-Za-z0-9]{3,40}$/;

export type ProgramStatus = "approved" | "pending" | "rejected" | "ended" | "unknown";

export interface RawProgramRow {
  programId: string;
  /** Visible text of the row. Used to decide the status, then dropped. */
  text: string;
  hrefs: string[];
}

export interface PartneredProgram {
  programId: string;
  status: ProgramStatus;
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

export function parseProgramRows(rows: readonly RawProgramRow[]): PartneredProgram[] {
  const seen = new Set<string>();
  const programs: PartneredProgram[] = [];
  for (const row of rows) {
    if (!PROGRAM_ID.test(row.programId) || seen.has(row.programId)) continue;
    seen.add(row.programId);
    programs.push({
      programId: row.programId,
      status: classifyProgramStatus(row.text, row.hrefs),
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
  };
}

export interface ProbeNode {
  tag: string;
  cls: string[];
  id?: string;
  name?: string;
  type?: string;
  href?: string;
  /** The element's own text, not its children's. */
  text: string;
  children: ProbeNode[];
}

/** Tags whose text is interface wording (column headings, buttons, form labels), never page data. */
const LABEL_TAGS = new Set(["th", "button", "label", "legend", "option", "caption", "summary", "h1", "h2", "h3", "h4", "h5"]);
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

function describeNode(node: ProbeNode, masked: boolean): string {
  const parts: string[] = [node.tag];
  if (node.id) parts.push(`#${node.id}`);
  if (node.cls.length > 0) parts.push(`.${node.cls.slice(0, 3).join(".")}`);
  const attributes = [node.name ? `name=${node.name}` : "", node.type ? `type=${node.type}` : ""].filter(Boolean);
  if (attributes.length > 0) parts.push(` [${attributes.join(" ")}]`);
  if (node.href !== undefined) parts.push(` -> ${hrefShape(node.href)}`);
  const text = node.text.trim();
  if (text) {
    const isLabel = LABEL_TAGS.has(node.tag) && text.length <= PROBE_LABEL_MAX;
    const isShortOutsideRows = !masked && text.length <= PROBE_SHORT_TEXT_MAX;
    parts.push(isLabel || isShortOutsideRows ? ` "${text}"` : ` T${text.length}${statusWordsIn(text)}`);
  }
  return parts.join("");
}

/**
 * Renders a page's element tree as indented lines for a public log. Text is shown
 * only for interface labels and for short text outside a program row (a row being
 * any element that contains exactly one program's links); everything else is a length.
 */
export function renderProbe(root: ProbeNode): string[] {
  const memo = new Map<ProbeNode, Set<string>>();
  idsIn(root, memo);
  const lines: string[] = [];
  let truncated = false;

  const visit = (node: ProbeNode, depth: number, insideRow: boolean): void => {
    if (lines.length >= PROBE_MAX_LINES) {
      truncated = true;
      return;
    }
    const masked = insideRow || node.tag === "td" || memo.get(node)?.size === 1;
    lines.push(`${"  ".repeat(Math.min(depth, 12))}${describeNode(node, masked)}`);
    for (const child of node.children) visit(child, depth + 1, masked);
  };
  visit(root, 0, false);
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
    const container = anchor.closest("tr, li, article") || (anchor.parentElement && anchor.parentElement.parentElement) || anchor;
    const hrefs = Array.from(container.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") || "").slice(0, 30);
    rows.set(match[1], {
      programId: match[1],
      text: (container.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 400),
      hrefs,
    });
  }
  return Array.from(rows.values());
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
      href: element.tagName === "A" ? element.getAttribute("href") || "" : undefined,
      text: own,
      children,
    };
  };
  return walk(document.body, 0);
})()`;

export interface ProgramsReport {
  outcome: "ok" | "login_failed";
  login?: A8SmokeResult;
  pagesRead?: number;
  programs?: ProgramSummary;
  probe?: string[];
}

async function readListPage(page: Page, pageNo: number): Promise<RawProgramRow[]> {
  const url = `${CONSOLE_ORIGIN}${PARTNERED_PATH}?pageNo=${pageNo}&pageSize=${PAGE_SIZE}&sortKey=APPROVED_DATE&sortOrder=DESC`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (safePath(page.url()) !== PARTNERED_PATH) {
    throw new Error(`the partnered list redirected to ${safePath(page.url())}; the session is not usable`);
  }
  return (await page.evaluate(READ_PROGRAM_ROWS)) as RawProgramRow[];
}

async function readAllPrograms(page: Page, probeFirstPage: boolean): Promise<{ programs: PartneredProgram[]; pages: number; probe?: string[] }> {
  const found = new Map<string, PartneredProgram>();
  let probe: string[] | undefined;
  let pages = 0;
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
    const rows = await readListPage(page, pageNo);
    if (pageNo === 1 && probeFirstPage) {
      probe = renderProbe((await page.evaluate(DUMP_TREE)) as ProbeNode);
    }
    pages = pageNo;
    const fresh = parseProgramRows(rows).filter((program) => !found.has(program.programId));
    if (fresh.length === 0) break;
    for (const program of fresh) found.set(program.programId, program);
  }
  return { programs: Array.from(found.values()), pages, ...(probe ? { probe } : {}) };
}

/** Logs in, reads the partnered list and returns counts by status. Changes nothing in the console. */
export async function runA8Programs(env: NodeJS.ProcessEnv): Promise<ProgramsReport> {
  const probe = env.A8_PROBE === "1";
  const { login, value } = await withA8Session(env, (page) => readAllPrograms(page, probe));
  if (!value) return { outcome: "login_failed", login };
  return {
    outcome: "ok",
    pagesRead: value.pages,
    programs: summarizePrograms(value.programs),
    ...(value.probe ? { probe: value.probe } : {}),
  };
}
