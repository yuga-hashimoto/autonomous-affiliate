import { registrableHost, restrictionReasons, slugForHost } from "@aff/agents";
import { classifyProgramStatus, programIdOf, verticalOf, type RawProgramRow } from "./a8-programs.js";
import { rowMatchesKeyword } from "./a8-sync.js";
import { isNotPartneredDetail } from "./a8-apply.js";
import { pickDetailPath } from "./a8-inspect.js";

/**
 * The rules for picking a new advertiser out of what the A8 console shows (docs/21). Everything
 * here is code over text that was read: the page's words are untrusted data and decide nothing
 * but through these rules, and an answer that is not clear is a "no".
 */

/** What to search for in the console, by vertical. Only a vertical the content path can write about is listed (docs/18). */
export const SCOUT_SEARCHES: Readonly<Record<string, readonly string[]>> = {
  water_delivery: ["ウォーターサーバー", "宅配水"],
};

/** The keyword that finds a program on the console is the advertiser's name, so it has to fit the brand schema. */
const NAME_MAX = 40;
const NAME_MIN = 2;

export interface ScoutCandidate {
  programId: string;
  /** The advertiser's name as the card shows it. */
  name: string;
  /** The account has joined already (the card opens the partnered page). */
  joined: boolean;
  /** The detail page to read. */
  detailPath: string;
}

/** A card is of the vertical when its name says so, or when the card shows the word the search was for. */
function inVertical(row: RawProgramRow, name: string, verticalId: string): boolean {
  return verticalOf(name) === verticalId || (SCOUT_SEARCHES[verticalId] ?? []).some((word) => row.text.includes(word));
}

/** Programs of the vertical that no configured brand covers, each once. */
export function candidatesFromRows(
  rows: readonly RawProgramRow[],
  verticalId: string,
  configuredKeywords: readonly string[],
): ScoutCandidate[] {
  const seen = new Set<string>();
  const found: ScoutCandidate[] = [];
  for (const row of rows) {
    const name = row.name?.trim() ?? "";
    if (name.length < NAME_MIN || name.length > NAME_MAX) continue;
    if (seen.has(row.programId) || !inVertical(row, name, verticalId)) continue;
    if (configuredKeywords.some((keyword) => rowMatchesKeyword(row, keyword))) continue;
    const status = classifyProgramStatus(row.text, row.hrefs);
    if (status === "ended" || status === "rejected") continue;
    const detailPath = pickDetailPath(row);
    if (!detailPath || programIdOf(detailPath) !== row.programId) continue;
    seen.add(row.programId);
    found.push({ programId: row.programId, name, joined: !isNotPartneredDetail(detailPath), detailPath });
  }
  return found;
}

// ---- the program's own rules ----

export interface ProgramGate {
  ok: boolean;
  reasons: string[];
}

/** Whether the program's rules, as the console shows them, leave room for an article that compares prices. */
export function programGate(detailText: string): ProgramGate {
  const reasons = restrictionReasons(detailText);
  return { ok: reasons.length === 0, reasons };
}

// ---- the advertiser's site ----

export { registrableHost, slugForHost };

/** Addresses on a page that are not the advertiser's: the ASP itself and the usual social and media sites. */
const NOT_THE_ADVERTISER = [
  "a8.net",
  "a8.jp",
  "google.com",
  "google.co.jp",
  "youtube.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "line.me",
  "apple.com",
  "w3.org",
  "fancs.com",
];
const SITE_LINK_WORDING = /公式|サイト|ホームページ|HP|URL|広告主/i;
const ADDRESS_IN_TEXT = /https?:\/\/([A-Za-z0-9.-]+)/g;

export interface SiteHost {
  host?: string;
  via: "labeled_link" | "only_outside_link" | "address_in_text" | "ambiguous" | "none";
}

function outsideHost(address: string): string | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const registrable = registrableHost(url.hostname);
  if (!registrable) return undefined;
  return NOT_THE_ADVERTISER.some((blocked) => registrable === blocked) ? undefined : registrable;
}

const only = (hosts: Set<string>): { host: string } | "ambiguous" | undefined => {
  if (hosts.size === 1) return { host: [...hosts][0]! };
  return hosts.size > 1 ? "ambiguous" : undefined;
};

/**
 * The advertiser's own site from a program's detail page: a link that says it is the site, then the
 * only link that leaves the console, then an address written in the text. Two different sites at the
 * same step are no answer.
 */
export function siteHostFromDetail(page: { links: readonly { href: string; text: string }[]; text: string }): SiteHost {
  const outside = page.links.flatMap((link) => {
    const host = outsideHost(link.href);
    return host ? [{ host, text: link.text }] : [];
  });
  const steps: readonly [SiteHost["via"], Set<string>][] = [
    ["labeled_link", new Set(outside.filter((link) => SITE_LINK_WORDING.test(link.text)).map((link) => link.host))],
    ["only_outside_link", new Set(outside.map((link) => link.host))],
    [
      "address_in_text",
      new Set(
        [...page.text.matchAll(ADDRESS_IN_TEXT)].flatMap((match) => {
          const host = outsideHost(`https://${match[1] ?? ""}`);
          return host ? [host] : [];
        }),
      ),
    ],
  ];
  for (const [via, hosts] of steps) {
    const answer = only(hosts);
    if (answer === "ambiguous") return { via: "ambiguous" };
    if (answer) return { host: answer.host, via };
  }
  return { via: "none" };
}
