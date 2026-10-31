import type { ScoutedBrand } from "@aff/db";
import type { PolicyConfig } from "@aff/domain";
import type { A8Brand, A8ProgramsConfig } from "./a8-offers.js";
import type { DiscoverySource } from "./plan-discovery.js";
import { TRANSIENT_REASONS } from "./site-vet.js";

/**
 * Advertisers the daily run picked itself (docs/21), seen by the rest of the run as if they had been
 * written in `config/a8-programs.json` and `config/discovery.live.json`. They live in the database;
 * these functions only combine them with the written ones and never write anything.
 */

const DAY_MS = 86_400_000;
/** A refusal that is about the site is looked at again after this long; one about the moment, after `RETRY_TRANSIENT_DAYS`. */
export const RECHECK_REFUSED_DAYS = 30;
export const RETRY_TRANSIENT_DAYS = 0.5;

export function brandOfScouted(brand: ScoutedBrand): A8Brand | undefined {
  if (!brand.termsUrl || !brand.termsSha256) return undefined;
  return {
    brandSlug: brand.brandSlug,
    keyword: brand.keyword,
    verticalId: "water_delivery",
    termsUrl: brand.termsUrl,
    termsSha256: brand.termsSha256,
    // Never the company's name at the start of a title: the stricter reading of the usual rule, for a brand whose rules were not read by a person.
    trademarkTerms: [...new Set([brand.brandName, brand.keyword])],
  };
}

/** The scouted advertisers that are registered (vetted or joined) and do not take a written brand's slug or name, once each. */
export function scoutedInUse(config: A8ProgramsConfig, scouted: readonly ScoutedBrand[]): ScoutedBrand[] {
  const slugs = new Set(config.brands.map((brand) => brand.brandSlug));
  const keywords = new Set(config.brands.map((brand) => brand.keyword));
  const accepted: ScoutedBrand[] = [];
  for (const entry of scouted) {
    if (entry.state !== "vetted" && entry.state !== "active") continue;
    const brand = brandOfScouted(entry);
    if (!brand || slugs.has(brand.brandSlug) || keywords.has(brand.keyword)) continue;
    slugs.add(brand.brandSlug);
    keywords.add(brand.keyword);
    accepted.push(entry);
  }
  return accepted;
}

/** The written brands, then the scouted ones in use. */
export function withScoutedBrands(config: A8ProgramsConfig, scouted: readonly ScoutedBrand[]): A8ProgramsConfig {
  const added = scoutedInUse(config, scouted).flatMap((entry) => brandOfScouted(entry) ?? []);
  return { ...config, brands: [...config.brands, ...added] };
}

const joined = (brand: ScoutedBrand): boolean => brand.state === "active";

/** Where the plans of the advertisers the account has joined are read from. */
export function activeScoutedSources(scouted: readonly ScoutedBrand[]): DiscoverySource[] {
  return scouted.filter(joined).map((brand) => ({
    verticalId: "water_delivery",
    brandSlug: brand.brandSlug,
    brandName: brand.brandName,
    listUrls: brand.listUrls,
    sourceUrls: brand.sourceUrls,
    months: 24,
    monthlyLiters: 25,
  }));
}

/** The policy with the hosts of the joined advertisers allowed as sources. The policy itself is not changed. */
export function withScoutedDomains(policy: PolicyConfig, scouted: readonly ScoutedBrand[]): PolicyConfig {
  const hosts = scouted.filter(joined).map((brand) => brand.host);
  const allowed = [...new Set([...policy.security.allowed_source_domains, ...hosts])];
  return { ...policy, security: { ...policy.security, allowed_source_domains: allowed } };
}

/** Programs not to read again now: registered ones, and refused ones that are not due for another look. */
export function knownProgramIds(scouted: readonly ScoutedBrand[], now: Date): Set<string> {
  const known = new Set<string>();
  for (const brand of scouted) {
    if (brand.state !== "rejected") {
      known.add(brand.programId);
      continue;
    }
    const transient = brand.reasons.length > 0 && brand.reasons.every((reason) => TRANSIENT_REASONS.has(reason));
    const days = (now.getTime() - Date.parse(brand.checkedAt)) / DAY_MS;
    if (days < (transient ? RETRY_TRANSIENT_DAYS : RECHECK_REFUSED_DAYS)) known.add(brand.programId);
  }
  return known;
}
