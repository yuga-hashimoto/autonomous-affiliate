import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Repository } from "@aff/db";
import { extractTrackingUrl } from "./a8-harvest.js";

/**
 * The redirect registry the site builds `/go/<offerId>` from (apps/site/src/pages/go). It is
 * written just before the site build, from the database, and is never committed: the ad links
 * are the account's. A link that is not exactly an A8 tracking URL is dropped, so a bad row can
 * never turn the redirect into an open redirect.
 */

const OFFER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface GoOffersFile {
  offers: Record<string, string>;
}

export function goOffersFile(resolved: Readonly<Record<string, string>>): { file: GoOffersFile; skipped: number } {
  const offers: Record<string, string> = {};
  let skipped = 0;
  for (const [offerId, url] of Object.entries(resolved)) {
    if (OFFER_ID.test(offerId) && extractTrackingUrl(url) === url) offers[offerId] = url;
    else skipped += 1;
  }
  return { file: { offers }, skipped };
}

/**
 * Cloudflare Pages `_redirects`: one temporary redirect per offer. The host then answers /go/<offer>
 * with a redirect straight away; the built page of the same path (a meta refresh) is only the fallback.
 */
export function redirectsFile(file: GoOffersFile): string {
  return Object.entries(file.offers)
    .map(([offerId, url]) => `/go/${offerId} ${url} 302\n`)
    .join("");
}

/**
 * Writes the registry (and, when a path is given, the redirects file) for the offers that may be
 * monetized now. Returns counts only.
 */
export async function exportGoOffers(
  repo: Repository,
  outPath: string,
  redirectsPath?: string,
): Promise<{ offers: number; skipped: number }> {
  const { file, skipped } = goOffersFile(await repo.offers.listOfferTrackingUrls());
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  if (redirectsPath !== undefined) {
    await mkdir(dirname(redirectsPath), { recursive: true });
    await writeFile(redirectsPath, redirectsFile(file), "utf8");
  }
  return { offers: Object.keys(file.offers).length, skipped };
}
