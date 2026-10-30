import type { Page } from "playwright";
import type { Repository } from "@aff/db";
import {
  applyBrandObservation,
  termsFingerprint,
  type A8Brand,
  type A8ProgramsConfig,
  type BrandObservation,
  type TermsState,
} from "@aff/agents";
import { checkRobots, htmlToVisibleText, type Fetcher } from "@aff/integrations";
import { startApplication } from "./a8-apply.js";
import { harvestTrackingUrl, type HarvestOutcome } from "./a8-harvest.js";
import { pickCreateLinkPath } from "./a8-linkpage.js";
import { withA8Session, type A8SmokeResult } from "./a8-login.js";
import { listState, readListPage, statusInList, type ListState, type RawProgramRow } from "./a8-programs.js";

/**
 * Keeps each configured brand's A8 program in step with the console (docs/20): finds it in the
 * joined list, reads its ad link for the site, applies when the account has not joined, and
 * stores what it saw. Members' program names, links and conditions are not public, and this
 * runs in a public log, so only counts by outcome are returned for printing.
 */

const MAX_LIST_PAGES = 10;
const APPLY_RESULT_PAGE = "/program/agreement/apply-result";

/** What the sync needs from the console; the real one drives the page, tests script it. */
export interface A8Console {
  readPartnered(): Promise<{ state: ListState; rows: RawProgramRow[] }>;
  readApplying(): Promise<{ state: ListState; rows: RawProgramRow[] }>;
  harvest(createLinkPath: string): Promise<HarvestOutcome>;
  apply(keyword: string): Promise<"applied" | "refused">;
}

/** A card is the brand's by the advertiser name it shows; the card's other text (other programs it mentions) does not count. */
export function rowMatchesKeyword(row: RawProgramRow, keyword: string): boolean {
  return (row.name?.trim() || row.text).includes(keyword);
}

async function readJoined(console: A8Console, brand: A8Brand): Promise<BrandObservation | { found: RawProgramRow | undefined }> {
  const partnered = await console.readPartnered();
  if (partnered.state === "unrecognized") return { kind: "unreadable", reason: "list_unrecognized" };
  const matches = partnered.rows.filter((row) => rowMatchesKeyword(row, brand.keyword));
  if (matches.length > 1) return { kind: "unreadable", reason: "more_than_one_program" };
  return { found: matches[0] };
}

async function linkOf(console: A8Console, row: RawProgramRow): Promise<BrandObservation> {
  const usable = statusInList("partnered", row.text, row.hrefs) === "approved";
  const path = usable ? pickCreateLinkPath(row) : undefined;
  if (!path) return { kind: "joined_unreadable", reason: "no_ad_link_page" };
  const harvested = await console.harvest(path);
  return harvested.ok ? { kind: "linked", url: harvested.url } : { kind: "joined_unreadable", reason: harvested.reason };
}

/**
 * One brand: its link when joined, an application when not (while the run may still apply),
 * and a second look after applying, since some programs join at once. `applied` tells the
 * caller to count the application against the run's limit.
 */
export async function observeBrand(
  console: A8Console,
  brand: A8Brand,
  canApply: boolean,
): Promise<{ observation: BrandObservation; applied: boolean }> {
  const first = await readJoined(console, brand);
  if ("kind" in first) return { observation: first, applied: false };
  if (first.found) return { observation: await linkOf(console, first.found), applied: false };

  const applying = await console.readApplying();
  if (applying.rows.some((row) => rowMatchesKeyword(row, brand.keyword))) {
    return { observation: { kind: "not_joined", application: "applying" }, applied: false };
  }
  if (!canApply) return { observation: { kind: "not_joined", application: "skipped" }, applied: false };
  if ((await console.apply(brand.keyword)) !== "applied") {
    return { observation: { kind: "not_joined", application: "skipped" }, applied: false };
  }

  const again = await readJoined(console, brand);
  if (!("kind" in again) && again.found) return { observation: await linkOf(console, again.found), applied: true };
  return { observation: { kind: "not_joined", application: "applied" }, applied: true };
}

async function readAllPartnered(page: Page): Promise<{ state: ListState; rows: RawProgramRow[] }> {
  const rows = new Map<string, RawProgramRow>();
  let state: ListState = "empty";
  for (let pageNo = 1; pageNo <= MAX_LIST_PAGES; pageNo += 1) {
    const read = await readListPage(page, "partnered", pageNo);
    if (pageNo === 1) state = listState({ rows: read.rows.length, noDataShown: read.noDataShown });
    const before = rows.size;
    for (const row of read.rows) if (!rows.has(row.programId)) rows.set(row.programId, row);
    if (rows.size === before) break;
  }
  return { state, rows: Array.from(rows.values()) };
}

function consoleOver(page: Page, siteName: string): A8Console {
  return {
    readPartnered: () => readAllPartnered(page),
    async readApplying() {
      const read = await readListPage(page, "applying", 1);
      return { state: listState({ rows: read.rows.length, noDataShown: read.noDataShown }), rows: read.rows };
    },
    harvest: (path) => harvestTrackingUrl(page, path, siteName),
    async apply(keyword) {
      const report = await startApplication(page, keyword, siteName, { requireSingleMatch: true });
      return report.outcome === "reached" && report.reached?.page === APPLY_RESULT_PAGE ? "applied" : "refused";
    },
  };
}

/** Whether the advertiser's public partner-rules page is still the one that was read. */
export async function checkTerms(fetcher: Fetcher, brand: A8Brand): Promise<TermsState> {
  try {
    const robots = await checkRobots(fetcher, brand.termsUrl);
    if (robots.disallowsAll) return "unreadable";
    const page = await fetcher.fetch(brand.termsUrl);
    if (page.status < 200 || page.status >= 300) return "unreadable";
    return termsFingerprint(htmlToVisibleText(page.body, page.contentType)) === brand.termsSha256 ? "unchanged" : "changed";
  } catch {
    return "unreadable";
  }
}

export interface SyncReport {
  outcome: "ok" | "login_failed";
  login?: A8SmokeResult;
  brands: number;
  /** Brands by what happened to them: no names, links or ids. */
  results?: Record<string, number>;
  /** Terms-page checks by outcome. */
  terms?: Record<string, number>;
  applications?: number;
}

export interface SyncDeps {
  config: A8ProgramsConfig;
  repo: Repository;
  fetcher: Fetcher;
  clock: () => Date;
}

const tally = (labels: readonly string[]): Record<string, number> =>
  labels.reduce<Record<string, number>>((counts, label) => ({ ...counts, [label]: (counts[label] ?? 0) + 1 }), {});

/** Logs in once, observes every brand, and stores what the console showed. */
export async function runA8Sync(env: NodeJS.ProcessEnv, deps: SyncDeps): Promise<SyncReport> {
  const { config, repo, fetcher, clock } = deps;
  const terms = new Map<string, TermsState>();
  for (const brand of config.brands) terms.set(brand.brandSlug, await checkTerms(fetcher, brand));

  const { login, value } = await withA8Session(env, async (page) => {
    const console = consoleOver(page, config.siteName);
    const seen = new Map<string, BrandObservation>();
    let applicationsLeft = config.applicationsPerRun;
    for (const brand of config.brands) {
      const { observation, applied } = await observeBrand(console, brand, applicationsLeft > 0);
      if (applied) applicationsLeft -= 1;
      seen.set(brand.brandSlug, observation);
    }
    return { seen, applications: config.applicationsPerRun - applicationsLeft };
  });
  if (!value) return { outcome: "login_failed", login, brands: config.brands.length };

  const labels: string[] = [];
  for (const brand of config.brands) {
    labels.push(await applyBrandObservation(repo, brand, value.seen.get(brand.brandSlug)!, terms.get(brand.brandSlug)!, clock()));
  }
  return {
    outcome: "ok",
    brands: config.brands.length,
    results: tally(labels),
    terms: tally([...terms.values()]),
    applications: value.applications,
  };
}
