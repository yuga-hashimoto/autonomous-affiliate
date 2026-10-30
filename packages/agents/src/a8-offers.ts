import { z } from "zod";
import { isFresh, sha256Hex, type AffiliateOffer, type PolicyConfig } from "@aff/domain";
import type { Repository } from "@aff/db";
import type { ArticlePlan } from "./pipeline.js";

/**
 * The link between the A8 console and the articles (docs/20). A brand in `config/a8-programs.json`
 * names a program to look for by its advertiser; what the console shows about it decides whether
 * the program's offers may carry a revenue link. Nothing here reads the console: the worker does,
 * and hands over a `BrandObservation`. All rules are code, none is a model's judgement.
 */

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const brandSchema = z
  .object({
    brandSlug: z.string().regex(slugPattern),
    /** The advertiser's name as the console's program card shows it. */
    keyword: z.string().trim().min(2).max(40),
    verticalId: z.string().min(1),
    /** The advertiser's public page of rules for partners. */
    termsUrl: z.string().url().startsWith("https://"),
    /** `termsFingerprint` of that page as it was when the rules were last read; a change turns the links off. */
    termsSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Words the rules keep out of the start of a page title (QA: offer_title_rule). */
    trademarkTerms: z.array(z.string().min(1)).default([]),
  })
  .strict();

const fileSchema = z
  .object({
    $comment: z.string().optional(),
    /** The site of the account whose links are used. */
    siteName: z.string().trim().min(1),
    /** How many programs one run may apply to. */
    applicationsPerRun: z.number().int().min(0).max(3).default(1),
    brands: z.array(brandSchema).min(1),
  })
  .strict()
  .refine((file) => new Set(file.brands.map((brand) => brand.brandSlug)).size === file.brands.length, {
    message: "brandSlug must be unique",
  });

export type A8Brand = z.infer<typeof brandSchema>;
export type A8ProgramsConfig = Omit<z.infer<typeof fileSchema>, "$comment">;

export function parseA8ProgramsFile(text: string): A8ProgramsConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("a8 programs file invalid: not JSON");
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`a8 programs file invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const { $comment: _comment, ...config } = parsed.data;
  return config;
}

export const programIdFor = (brandSlug: string): string => `prog-a8-${brandSlug}`;

/** The brand an offer id (`offer-<brandSlug>-<service>`) belongs to; the longest slug wins. */
export function brandOfOfferId(offerId: string, brands: readonly A8Brand[]): A8Brand | undefined {
  return [...brands]
    .sort((a, b) => b.brandSlug.length - a.brandSlug.length)
    .find((brand) => offerId.startsWith(`offer-${brand.brandSlug}-`) && offerId.length > `offer-${brand.brandSlug}-`.length);
}

/** The offers a plan compares: the drafted service, or each written calculator's. */
export function offersOfPlan(plan: ArticlePlan): { id: string; title: string }[] {
  const found = new Map<string, string>();
  if (plan.draft) found.set(plan.draft.offerId, plan.draft.title);
  for (const entry of plan.calculators) {
    const id = String(entry.input.offerId);
    if (!found.has(id)) found.set(id, String(entry.input.title ?? id));
  }
  return [...found].map(([id, title]) => ({ id, title }));
}

/** A page's rules reduced to their words, so layout and spacing do not count as a change. */
export function termsFingerprint(visibleText: string): string {
  return sha256Hex(visibleText.normalize("NFKC").replace(/\s+/gu, " ").trim());
}

export type BrandObservation =
  | { kind: "linked"; url: string }
  /** Joined, but the link could not be read this time. */
  | { kind: "joined_unreadable"; reason: string }
  | { kind: "not_joined"; application: "applied" | "applying" | "skipped" | "none" }
  /** The console's lists were not understood (or the brand matched more than one program). */
  | { kind: "unreadable"; reason: string };

export type TermsState = "unchanged" | "changed" | "unreadable";

/**
 * Stores what the console showed for a brand. A program record changes only on a clear
 * reading: a page that could not be read, or a link that could not be found, leaves what was
 * known. The terms check is renewed only when the rules page is still the one that was read.
 * Returns a label that is safe for a public log.
 */
export async function applyBrandObservation(
  repo: Repository,
  brand: A8Brand,
  observation: BrandObservation,
  terms: TermsState,
  now: Date,
): Promise<string> {
  const id = programIdFor(brand.brandSlug);
  const previous = await repo.offers.getProgram(id);
  switch (observation.kind) {
    case "unreadable":
      return "unreadable";
    case "joined_unreadable":
      return "joined_unreadable";
    case "linked": {
      await repo.offers.upsertProgram({
        id,
        provider: "a8",
        status: "APPROVED",
        termsUrl: brand.termsUrl,
        ...(terms === "unchanged" ? { termsCheckedAt: now.toISOString() } : previous?.termsCheckedAt ? { termsCheckedAt: previous.termsCheckedAt } : {}),
        payoutCurrency: "JPY",
      });
      await repo.offers.setProgramTrackingUrl(id, observation.url);
      return terms === "unchanged" ? "linked" : terms === "changed" ? "linked_terms_changed" : "linked_terms_unreadable";
    }
    case "not_joined": {
      if (observation.application === "applied" || observation.application === "applying") {
        await repo.offers.upsertProgram({ id, provider: "a8", status: "PENDING", termsUrl: brand.termsUrl, payoutCurrency: "JPY" });
        await repo.offers.setProgramTrackingUrl(id, undefined);
        return observation.application;
      }
      if (previous?.status === "APPROVED") {
        await repo.offers.upsertProgram({ ...previous, status: "TERMINATED" });
        await repo.offers.setProgramTrackingUrl(id, undefined);
        return "ended";
      }
      return "not_joined";
    }
  }
}

function offerFor(brand: A8Brand, entry: { id: string; title: string }, usable: boolean): AffiliateOffer {
  return {
    id: entry.id,
    programId: programIdFor(brand.brandSlug),
    verticalId: brand.verticalId,
    title: entry.title,
    // The reward is the program's member-only term; it is neither stored nor shown.
    rewardModel: "unknown",
    channelPermissions: ["site"],
    active: usable,
    status: usable ? "APPROVED" : "PENDING",
    constraints: brand.trademarkTerms.length > 0 ? { trademark_terms: brand.trademarkTerms.join("|") } : {},
  };
}

/**
 * Makes the offers of each brand's plans match what the program allows right now. An offer is on only
 * when its program is approved, has a link, and its terms check is recent; otherwise it is kept but
 * off, so an article is published without a link and never refused for one. Run before the plans.
 */
export async function ensureBrandOffers(
  repo: Repository,
  plans: readonly ArticlePlan[],
  config: A8ProgramsConfig,
  policy: PolicyConfig,
  now: Date,
): Promise<{ offers: number; active: number }> {
  const usable = new Map<string, boolean>();
  const known = new Map<string, boolean>();
  for (const brand of config.brands) {
    const program = await repo.offers.getProgram(programIdFor(brand.brandSlug));
    known.set(brand.brandSlug, program !== undefined);
    usable.set(
      brand.brandSlug,
      program?.status === "APPROVED" &&
        program.termsCheckedAt !== undefined &&
        isFresh(program.termsCheckedAt, now, policy.content.price_source_max_age_days) &&
        (await repo.offers.hasProgramTrackingUrl(program.id)),
    );
  }

  const wanted = new Map<string, { brand: A8Brand; title: string }>();
  for (const plan of plans) {
    for (const entry of offersOfPlan(plan)) {
      const brand = brandOfOfferId(entry.id, config.brands);
      if (brand && known.get(brand.brandSlug)) wanted.set(entry.id, { brand, title: entry.title });
    }
  }
  for (const offer of await repo.offers.listOffers()) {
    const brand = brandOfOfferId(offer.id, config.brands);
    if (brand && offer.programId === programIdFor(brand.brandSlug) && !wanted.has(offer.id)) {
      wanted.set(offer.id, { brand, title: offer.title });
    }
  }

  let active = 0;
  for (const [id, { brand, title }] of wanted) {
    const on = usable.get(brand.brandSlug) === true;
    await repo.offers.upsertOffer(offerFor(brand, { id, title }, on));
    if (on) active += 1;
  }
  return { offers: wanted.size, active };
}
