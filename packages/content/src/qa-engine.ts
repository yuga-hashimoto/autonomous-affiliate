import type {
  AffiliateOffer,
  Fact,
  PolicyConfig,
  QualityDecision,
  QaCheck,
  SourceRecord,
} from "@aff/domain";
import { newId, sha256Hex } from "@aff/domain";
import type { FreshnessPolicy } from "@aff/integrations";
import { findProhibitedPhrases, AD_DISCLOSURE } from "./draft-types.js";
import type { Draft } from "./draft-types.js";

export interface QaEngineDeps {
  freshness: FreshnessPolicy;
  /** Known content hashes already published or drafted, for duplicate detection. */
  existingContentHashes: Set<string>;
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const SECRET_PATTERN = /(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|postgres(?:ql)?:\/\/\S+)/;
const AFFILIATE_LINK_PATTERN = /\[[^\]]*\]\((https?:\/\/[^)]+)\)/g;

function check(id: string, status: QaCheck["status"], detail: string): QaCheck {
  return { id, status, detail };
}

/**
 * B010: deterministic publish gates. A single FAIL or UNKNOWN check fails the
 * decision (fail closed, docs/04). The secondary LLM critique may add checks
 * but can never turn a FAIL into a PASS.
 */
export class QaEngine {
  constructor(
    private readonly policy: PolicyConfig,
    private readonly deps: QaEngineDeps,
  ) {}

  evaluate(input: {
    draft: Draft;
    facts: Fact[];
    offers: AffiliateOffer[];
    sources?: SourceRecord[];
    /**
     * Yen amounts of the article plan that no extracted official fact backs
     * (see agents/plan-evidence). When provided, any entry fails the article;
     * when omitted the gate is not evaluated (callers without a plan).
     */
    planEvidenceIssues?: string[];
    itemId?: string;
    revisionId?: string;
    now?: Date;
  }): QualityDecision {
    const now = input.now ?? new Date();
    const checks: QaCheck[] = [];
    const draft = input.draft;
    const sources = input.sources ?? [];

    // 1. Ad disclosure at the visible top of the article.
    const firstLines = draft.bodyMarkdown.split("\n").slice(0, 5).join("\n");
    checks.push(
      draft.disclosure.trim() !== "" && firstLines.includes(AD_DISCLOSURE)
        ? check("ad_disclosure_present", "PASS", "PR表記が冒頭に存在します")
        : check("ad_disclosure_present", "FAIL", "PR表記が冒頭にありません"),
    );

    // 2. Every claim references fresh, VERIFIED facts with sources that really exist.
    const factById = new Map(input.facts.map((f) => [f.id, f]));
    const sourceIds = new Set(sources.map((s) => s.id));
    const unevidenced: string[] = [];
    const fabricated: string[] = [];
    const stale: string[] = [];
    const unlinkedPrices: string[] = [];
    for (const claim of draft.claims) {
      if (claim.sourceIds.length === 0) {
        unevidenced.push(claim.claimId);
        continue;
      }
      // Fabricated evidence ids (not in the verified source registry) fail.
      const unknownSources = claim.sourceIds.filter((id) => !sourceIds.has(id));
      if (unknownSources.length > 0) {
        fabricated.push(`${claim.claimId}(${unknownSources.join(",")})`);
        continue;
      }
      const backingFacts = claim.factIds.map((id) => factById.get(id)).filter((f): f is Fact => Boolean(f));
      // Claim fact references must exist, too.
      const missingFacts = claim.factIds.filter((id) => !factById.has(id));
      if (missingFacts.length > 0) {
        fabricated.push(`${claim.claimId}(${missingFacts.join(",")})`);
        continue;
      }
      if (claim.claimType === "price" && backingFacts.length === 0) {
        // A generated price/total must link to structured official price facts,
        // not merely to an arbitrary existing URL (fail closed on unproven inputs).
        unlinkedPrices.push(claim.claimId);
      }
      const factsFromOtherSources = backingFacts.filter(
        (fact) => !fact.sourceIds.some((id) => claim.sourceIds.includes(id)),
      );
      if (factsFromOtherSources.length > 0) {
        fabricated.push(`${claim.claimId}(fact_source_mismatch)`);
        continue;
      }
      const usable = backingFacts.filter((f) => this.deps.freshness.isFactUsable(f, now));
      if (backingFacts.length > 0 && usable.length === 0) {
        stale.push(claim.claimId);
      }
    }
    checks.push(
      unevidenced.length === 0
        ? check("claims_all_evidenced", "PASS", "全主張に出典参照があります")
        : check("claims_all_evidenced", "FAIL", `出典なしの主張: ${unevidenced.join(", ")}`),
    );
    checks.push(
      fabricated.length === 0
        ? check("evidence_ids_exist", "PASS", "主張の参照するfact/sourceは実在します")
        : check("evidence_ids_exist", "FAIL", `捏造された参照: ${fabricated.join(", ")}`),
    );
    checks.push(
      unlinkedPrices.length === 0
        ? check("price_claims_linked_to_facts", "PASS", "価格主張は公式Factに結び付いています")
        : check("price_claims_linked_to_facts", "FAIL", `公式Factに結び付かない価格主張: ${unlinkedPrices.join(", ")}`),
    );
    checks.push(
      stale.length === 0
        ? check("claims_fresh", "PASS", "全主張が鮮度基準内です")
        : check("claims_fresh", "FAIL", `鮮度切れの主張: ${stale.join(", ")}`),
    );

    // 2b. Amounts typed into the plan must be backed by what the official pages say.
    if (input.planEvidenceIssues !== undefined) {
      checks.push(
        input.planEvidenceIssues.length === 0
          ? check("plan_numbers_match_facts", "PASS", "計画の金額はすべて公式Factで確認できます")
          : check(
              "plan_numbers_match_facts",
              "FAIL",
              `公式Factで確認できない計画の金額: ${input.planEvidenceIssues.join(" / ")}`,
            ),
      );
    }

    // 3. Prices carry formula + assumptions.
    const hasFormula = draft.bodyMarkdown.includes("計算式:") && draft.bodyMarkdown.includes("前提:");
    checks.push(
      this.policy.content.require_price_formula && hasFormula
        ? check("prices_have_formula_and_assumptions", "PASS", "計算式と前提が本文に含まれます")
        : this.policy.content.require_price_formula
          ? check("prices_have_formula_and_assumptions", "FAIL", "計算式または前提がありません")
          : check("prices_have_formula_and_assumptions", "PASS", "formula requirement disabled"),
    );

    // 4. No hands-on / experience claims.
    const prohibited = findProhibitedPhrases(draft.bodyMarkdown);
    checks.push(
      prohibited.length === 0
        ? check("no_hands_on_claims", "PASS", "体験・実測を装う表現はありません")
        : check(
            "no_hands_on_claims",
            "FAIL",
            `禁止表現: ${prohibited.map((p) => `${p.line}行目(${p.reason})`).join(", ")}`,
          ),
    );

    // 5. Affiliate CTAs reference only approved+active offers with site permission.
    const allowedOfferIds = new Set(
      input.offers
        .filter((o) => o.active && o.status === "APPROVED" && o.channelPermissions.includes("site"))
        .map((o) => o.id),
    );
    const referencedOfferIds = new Set(draft.offerIds);
    const illegal = [...referencedOfferIds].filter((id) => !allowedOfferIds.has(id));
    checks.push(
      illegal.length === 0
        ? check("offers_approved_and_active", "PASS", "掲載オファーは承認済みかつ有効です")
        : check("offers_approved_and_active", "FAIL", `未承認/無効オファーが参照されています: ${illegal.join(", ")}`),
    );

    // 6. Original value: an own calculation table must exist.
    const hasOriginalValue =
      draft.bodyMarkdown.includes("総額比較") || draft.bodyMarkdown.includes("条件別の比較表");
    checks.push(
      this.policy.content.require_original_value && hasOriginalValue
        ? check("has_original_value", "PASS", "独自の比較・計算表を含みます")
        : this.policy.content.require_original_value
          ? check("has_original_value", "FAIL", "独自価値（計算表・比較表）がありません")
          : check("has_original_value", "PASS", "original value requirement disabled"),
    );

    // 7. Uniform comparison unit.
    const months = draft.metadata.comparisonMonths;
    checks.push(
      months !== null
        ? check("comparison_units_match", "PASS", `比較期間は${months}ヶ月で統一されています`)
        : check("comparison_units_match", "FAIL", "比較期間の単位が確認できません"),
    );

    // 8. No secrets or PII in the artifact.
    const leaky = EMAIL_PATTERN.test(draft.bodyMarkdown) || SECRET_PATTERN.test(draft.bodyMarkdown);
    checks.push(
      leaky
        ? check("no_secrets_or_pii", "FAIL", "メールアドレスまたは秘密情報の疑いがある文字列が含まれます")
        : check("no_secrets_or_pii", "PASS", "秘密情報・PIIは含まれません"),
    );

    // 9. Duplicate detection across the site.
    const contentHash = sha256Hex(draft.bodyMarkdown);
    checks.push(
      this.deps.existingContentHashes.has(contentHash)
        ? check("no_duplicate_content", "FAIL", "同一内容の記事が既に存在します")
        : check("no_duplicate_content", "PASS", "重複記事はありません"),
    );

    // 9b. Draft links must point at verified official sources only; internal
    // /go/{offerId} anchors are the approved monetized route (rel=sponsored at
    // render time). Any other outbound link fails.
    const sourceUrls = new Set(sources.map((s) => s.canonicalUrl));
    const badLinks: string[] = [];
    for (const match of draft.bodyMarkdown.matchAll(AFFILIATE_LINK_PATTERN)) {
      const url = match[1]!;
      if (url.startsWith("/go/")) continue;
      if (!sourceUrls.has(url)) badLinks.push(url);
    }
    checks.push(
      badLinks.length === 0
        ? check("links_official_only", "PASS", "本文リンクは確認済みの公式出典のみです")
        : check("links_official_only", "FAIL", `出典外リンク: ${badLinks.join(", ")}`),
    );

    // 10. UNKNOWN facts must not be presented as resolved.
    const unknownClaim = draft.claims.filter((c) => c.text.includes("UNKNOWN"));
    checks.push(
      unknownClaim.length === 0
        ? check("unknown_not_presented_as_fact", "PASS", "UNKNOWNを確定値として表示していません")
        : this.policy.content.unknown_means_fail
          ? check("unknown_not_presented_as_fact", "FAIL", `UNKNOWNを含む主張: ${unknownClaim.map((c) => c.claimId).join(", ")}`)
          : check("unknown_not_presented_as_fact", "UNKNOWN", "UNKNOWN claim present"),
    );

    const status = checks.every((c) => c.status === "PASS")
      ? "PASS"
      : checks.some((c) => c.status === "FAIL")
        ? "FAIL"
        : "UNKNOWN";

    return {
      id: newId("qa"),
      itemId: input.itemId ?? input.draft.slug,
      revisionId: input.revisionId ?? draft.slug,
      artifactHash: contentHash,
      status,
      checks,
      policyVersion: this.policy.version,
      decidedAt: now.toISOString(),
    };
  }
}
