import type { Repository, ScoutedBrand } from "@aff/db";
import type { Fetcher } from "@aff/integrations";
import { TRANSIENT_REASONS, rereadTerms, slugForHost, type TermsState, type VetCandidate, type VetResult } from "@aff/agents";
import { READABLE_CHARS, type ReadCandidate } from "./a8-scout.js";

/**
 * Turns what the scouting read into records (docs/21): a candidate whose program rules and site pass is
 * registered as `vetted`, the rest are recorded with the reasons so they are not looked at again at
 * once. Names and sites go to the private database; the return value is counts by outcome.
 */

export interface RegisterDeps {
  repo: Repository;
  clock: () => Date;
  /** Slugs already in use by written brands. */
  taken: Set<string>;
  /** Looks at the advertiser's own site. */
  vet: (candidate: VetCandidate) => Promise<VetResult>;
  /** Sites looked at in one run. */
  maxVets: number;
  /** Advertisers in use (registered or joined) at the most. */
  maxRegistered: number;
}

const tally = (labels: readonly string[]): Record<string, number> =>
  labels.reduce<Record<string, number>>((counts, label) => ({ ...counts, [label]: (counts[label] ?? 0) + 1 }), {});

export async function registerCandidates(read: readonly ReadCandidate[], deps: RegisterDeps): Promise<Record<string, number>> {
  const { repo, taken } = deps;
  const checkedAt = deps.clock().toISOString();
  const registered = (await repo.scout.list()).filter((brand) => brand.state === "vetted" || brand.state === "active");
  for (const brand of registered) taken.add(brand.brandSlug);
  let room = deps.maxRegistered - registered.length;
  let vets = 0;
  const labels: string[] = [];

  const refuse = async (entry: ReadCandidate, reasons: string[], host = entry.site.host ?? ""): Promise<string> => {
    const brand: ScoutedBrand = {
      programId: entry.candidate.programId,
      brandSlug: `x-${entry.candidate.programId.toLowerCase()}`,
      state: "rejected",
      keyword: entry.candidate.name,
      host,
      brandName: entry.candidate.name,
      listUrls: [],
      sourceUrls: [],
      reasons,
      checkedAt,
    };
    await repo.scout.upsert(brand);
    return reasons.every((reason) => TRANSIENT_REASONS.has(reason)) ? "retry_later" : "rejected";
  };

  for (const entry of read) {
    const { candidate, gate, site } = entry;
    // A page that came back almost empty was not read (the console draws its pages late): look again tomorrow, do not judge it.
    if (entry.signals.chars < READABLE_CHARS) {
      labels.push(await refuse(entry, ["page_unreadable"]));
      continue;
    }
    if (!gate.ok) {
      labels.push(await refuse(entry, gate.reasons));
      continue;
    }
    if (!site.host) {
      labels.push(await refuse(entry, [`site_${site.via}`]));
      continue;
    }
    const brandSlug = slugForHost(site.host);
    if (!brandSlug) {
      labels.push(await refuse(entry, ["bad_slug"]));
      continue;
    }
    if (taken.has(brandSlug)) {
      labels.push(await refuse(entry, ["slug_taken"]));
      continue;
    }
    if (room <= 0 || vets >= deps.maxVets) {
      labels.push("waiting");
      continue;
    }
    vets += 1;
    const result = await deps.vet({ name: candidate.name, host: site.host, brandSlug });
    if (!result.ok) {
      labels.push(await refuse(entry, result.reasons));
      continue;
    }
    await repo.scout.upsert({
      programId: candidate.programId,
      brandSlug,
      state: "vetted",
      keyword: candidate.name,
      host: site.host,
      brandName: result.brandName,
      termsUrl: result.termsUrl,
      termsSha256: result.termsSha256,
      listUrls: result.listUrls,
      sourceUrls: result.sourceUrls,
      reasons: [],
      checkedAt,
    });
    taken.add(brandSlug);
    room -= 1;
    labels.push("vetted");
  }
  return tally(labels);
}

const DAY_MS = 86_400_000;
/** An advertiser registered this long ago that the account has not joined is given up on. */
export const GIVE_UP_AFTER_DAYS = 30;

/** Moves registered advertisers along by what the console showed for them today. */
export async function advanceScouted(
  repo: Repository,
  scouted: readonly ScoutedBrand[],
  labelOf: ReadonlyMap<string, string>,
  now: Date,
): Promise<Record<string, number>> {
  const labels: string[] = [];
  for (const brand of scouted) {
    if (brand.state !== "vetted" && brand.state !== "active") continue;
    const label = labelOf.get(brand.brandSlug) ?? "";
    const waitedDays = (now.getTime() - Date.parse(brand.checkedAt)) / DAY_MS;
    if (label.startsWith("linked") && brand.state === "vetted") {
      await repo.scout.upsert({ ...brand, state: "active" });
      labels.push("activated");
    } else if (label === "ended" || (brand.state === "vetted" && !label.startsWith("linked") && waitedDays > GIVE_UP_AFTER_DAYS)) {
      await repo.scout.upsert({ ...brand, state: "retired" });
      labels.push("retired");
    }
  }
  return tally(labels);
}

/**
 * An advertiser whose rules page changed: read it again, and keep using the advertiser (with the new
 * fingerprint) only if it still leaves room for the comparison. A page that cannot be read now changes nothing.
 */
export async function renewScoutedTerms(
  repo: Repository,
  fetcher: Fetcher,
  scouted: readonly ScoutedBrand[],
  terms: ReadonlyMap<string, TermsState>,
  now: Date,
): Promise<Record<string, number>> {
  const labels: string[] = [];
  for (const brand of scouted) {
    if ((brand.state !== "vetted" && brand.state !== "active") || terms.get(brand.brandSlug) !== "changed" || !brand.termsUrl) continue;
    const result = await rereadTerms(fetcher, brand.termsUrl, brand.host);
    if (result.ok) {
      await repo.scout.upsert({ ...brand, termsSha256: result.termsSha256 });
      labels.push("renewed");
    } else if (result.reasons.every((reason) => TRANSIENT_REASONS.has(reason) || reason === "terms_unreadable")) {
      labels.push("unreadable");
    } else {
      await repo.scout.upsert({ ...brand, state: "retired", reasons: result.reasons, checkedAt: now.toISOString() });
      labels.push("retired");
    }
  }
  return tally(labels);
}
