import type { Page } from "playwright";
import { withA8Session, type A8SmokeResult } from "./a8-login.js";
import { openProgramPage, searchFor } from "./a8-inspect.js";
import {
  DUMP_TREE,
  listState,
  renderProbe,
  type ListState,
  type ProbeNode,
  type RawProgramRow,
} from "./a8-programs.js";
import {
  SCOUT_SEARCHES,
  candidatesFromRows,
  programGate,
  siteHostFromDetail,
  type ProgramGate,
  type ScoutCandidate,
  type SiteHost,
} from "./a8-scout-rules.js";

/**
 * Looks for advertisers the daily run does not cover yet (docs/21): searches the console for each
 * vertical the content path can write about and reads the detail page of what is new. Reading
 * only. What the console shows about programs is member-only and the log is public, so what
 * comes out is counts; the optional probe prints the first detail page's structure with its
 * content masked.
 */

/** Detail pages read in one run. */
export const MAX_DETAIL_READS = 12;

export interface DetailPage {
  text: string;
  links: { href: string; text: string }[];
}

/**
 * Runs in the page. The visible text, then the text of parts that are folded away (tabs and
 * accordions often hold the rules), and the links. A string, because this project's TypeScript
 * config has no DOM types.
 */
export const READ_DETAIL_PAGE = `(() => {
  const root = document.querySelector("main") || document.body;
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const folded = [];
  for (const element of root.querySelectorAll("*")) {
    if (skip.has(element.tagName)) continue;
    const parent = element.parentElement;
    if (getComputedStyle(element).display !== "none" || !parent || getComputedStyle(parent).display === "none") continue;
    folded.push((element.textContent || "").replace(/\\s+/g, " ").trim());
  }
  return {
    text: [root.innerText || "", ...folded].join("\\n"),
    links: Array.from(root.querySelectorAll("a[href]")).slice(0, 400).map((anchor) => ({
      href: anchor.getAttribute("href") || "",
      text: (anchor.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40),
    })),
  };
})()`;

export interface ReadCandidate {
  candidate: ScoutCandidate;
  gate: ProgramGate;
  site: SiteHost;
}

export interface ScoutConsole {
  search(keyword: string): Promise<{ state: ListState; rows: RawProgramRow[] }>;
  detail(candidate: ScoutCandidate): Promise<DetailPage>;
}

export interface ScoutReport {
  outcome: "ok" | "login_failed" | "unrecognized";
  login?: A8SmokeResult;
  searches?: number;
  /** Cards seen across the searches, once each. */
  cards?: number;
  /** Cards of a vertical that no configured brand covers. */
  candidates?: number;
  joined?: number;
  /** Detail pages read (the rest wait for another run). */
  read?: number;
  passed?: number;
  /** Rejected candidates by reason: no names. */
  rejected?: Record<string, number>;
  /** Passed candidates by how their site was found. */
  sites?: Record<string, number>;
  probe?: string[];
}

const tally = (labels: readonly string[]): Record<string, number> =>
  labels.reduce<Record<string, number>>((counts, label) => ({ ...counts, [label]: (counts[label] ?? 0) + 1 }), {});

/** The candidates of every searched vertical, and how many cards the searches showed. */
export async function gatherCandidates(
  console: ScoutConsole,
  configuredKeywords: readonly string[],
): Promise<{ searches: number; cards: number; candidates: ScoutCandidate[]; unrecognized: boolean }> {
  const cards = new Map<string, RawProgramRow>();
  const candidates = new Map<string, ScoutCandidate>();
  let searches = 0;
  let unrecognized = false;
  for (const [verticalId, keywords] of Object.entries(SCOUT_SEARCHES)) {
    for (const keyword of keywords) {
      searches += 1;
      const found = await console.search(keyword);
      if (found.state === "unrecognized") unrecognized = true;
      for (const row of found.rows) if (!cards.has(row.programId)) cards.set(row.programId, row);
      for (const candidate of candidatesFromRows(found.rows, verticalId, configuredKeywords)) {
        if (!candidates.has(candidate.programId)) candidates.set(candidate.programId, candidate);
      }
    }
  }
  return { searches, cards: cards.size, candidates: [...candidates.values()], unrecognized };
}

/** Reads each candidate's detail page and applies the rules to it. */
export async function readCandidates(console: ScoutConsole, candidates: readonly ScoutCandidate[]): Promise<ReadCandidate[]> {
  const read: ReadCandidate[] = [];
  for (const candidate of candidates.slice(0, MAX_DETAIL_READS)) {
    const page = await console.detail(candidate);
    read.push({ candidate, gate: programGate(page.text), site: siteHostFromDetail(page) });
  }
  return read;
}

export function summarize(
  gathered: { searches: number; cards: number; candidates: ScoutCandidate[] },
  read: readonly ReadCandidate[],
): Omit<ScoutReport, "outcome" | "login" | "probe"> {
  const passed = read.filter((entry) => entry.gate.ok);
  return {
    searches: gathered.searches,
    cards: gathered.cards,
    candidates: gathered.candidates.length,
    joined: gathered.candidates.filter((candidate) => candidate.joined).length,
    read: read.length,
    passed: passed.length,
    rejected: tally(read.flatMap((entry) => entry.gate.reasons)),
    sites: tally(passed.map((entry) => entry.site.via)),
  };
}

function consoleOver(page: Page): ScoutConsole {
  return {
    async search(keyword) {
      const found = await searchFor(page, keyword);
      return { state: listState({ rows: found.rows.length, noDataShown: found.noDataShown }), rows: found.rows };
    },
    async detail(candidate) {
      await openProgramPage(page, candidate.detailPath);
      return (await page.evaluate(READ_DETAIL_PAGE)) as DetailPage;
    },
  };
}

/** Logs in once, searches, and reads the new candidates' detail pages. Changes nothing. */
export async function runA8Scout(
  env: NodeJS.ProcessEnv,
  configuredKeywords: readonly string[],
): Promise<ScoutReport> {
  const { login, value } = await withA8Session(env, async (page) => {
    const console = consoleOver(page);
    const gathered = await gatherCandidates(console, configuredKeywords);
    if (gathered.unrecognized) return { gathered, read: [] as ReadCandidate[], probe: undefined as string[] | undefined };
    const read = await readCandidates(console, gathered.candidates);
    const first = gathered.candidates[0];
    // The structure of one detail page, masked, to learn where a page keeps what the rules look for.
    let probe: string[] | undefined;
    if (env.A8_PROBE === "1" && first) {
      await openProgramPage(page, first.detailPath);
      probe = renderProbe((await page.evaluate(DUMP_TREE)) as ProbeNode, { redact: [first.name] });
    }
    return { gathered, read, probe };
  });
  if (!value) return { outcome: "login_failed", login };
  return {
    outcome: value.gathered.unrecognized ? "unrecognized" : "ok",
    ...summarize(value.gathered, value.read),
    ...(value.probe ? { probe: value.probe } : {}),
  };
}
