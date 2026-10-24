import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePolicy, parsePolicyText, PolicyValidationError } from "@aff/domain";

const examplePath = new URL("../../config/policy.example.yaml", import.meta.url);

describe("B002 policy loader", () => {
  it("accepts the shipped example policy", () => {
    const yaml = readFileSync(examplePath, "utf8");
    const policy = parsePolicyText(yaml);
    expect(policy.version).toBe("v1");
    expect(policy.mode).toBe("dry-run");
    expect(policy.limits.monthly_operating_cost_jpy).toBe(30000);
    expect(policy.security.allow_captcha_bypass).toBe(false);
  });

  it("rejects malformed YAML", () => {
    expect(() => parsePolicyText("version: [unclosed")).toThrow(PolicyValidationError);
  });

  it("rejects a negative monthly budget", () => {
    const raw = {
      version: "v1",
      timezone: "Asia/Tokyo",
      mode: "dry-run",
      flags: exampleFlags(),
      limits: { ...exampleLimits(), monthly_operating_cost_jpy: -1 },
      content: exampleContent(),
      security: exampleSecurity(),
      affiliate: exampleAffiliate(),
      operations: exampleOperations(),
      market_selection: exampleMarket(),
    };
    try {
      parsePolicy(raw);
      throw new Error("expected PolicyValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyValidationError);
      expect(
        (error as PolicyValidationError).issues.some((i) =>
          i.path.includes("monthly_operating_cost_jpy"),
        ),
      ).toBe(true);
    }
  });

  it("rejects unknown permission keys (strict schema)", () => {
    const raw = {
      ...minimalPolicy(),
      security: { ...exampleSecurity(), allow_arbitrary_code_exec: true },
    };
    expect(() => parsePolicy(raw)).toThrow(PolicyValidationError);
  });

  it("rejects dangerous permissions even when well-formed", () => {
    expect(() => parsePolicy({ ...minimalPolicy(), security: { ...exampleSecurity(), allow_captcha_bypass: true } })).toThrow(
      PolicyValidationError,
    );
    expect(() => parsePolicy({ ...minimalPolicy(), affiliate: { ...exampleAffiliate(), treat_pending_as_revenue: true } })).toThrow(
      PolicyValidationError,
    );
    expect(() => parsePolicy({ ...minimalPolicy(), flags: { ...exampleFlags(), paid_ads_enabled: true } })).toThrow(
      PolicyValidationError,
    );
  });

  it("rejects unknown timezone and bad version", () => {
    expect(() => parsePolicy({ ...minimalPolicy(), timezone: "Mars/Olympus" })).toThrow(
      PolicyValidationError,
    );
    expect(() => parsePolicy({ ...minimalPolicy(), version: "1" })).toThrow(PolicyValidationError);
  });

  it("rejects per-job cap above monthly cap", () => {
    const limits = { ...exampleLimits(), max_job_cost_jpy: 999_999 };
    expect(() => parsePolicy({ ...minimalPolicy(), limits })).toThrow(PolicyValidationError);
  });
});

function exampleFlags() {
  return {
    research_enabled: true,
    browser_testing_enabled: false,
    analysis_enabled: true,
    publish_enabled: false,
    youtube_enabled: false,
    social_enabled: false,
    paid_ads_enabled: false,
    affiliate_links_enabled: false,
  };
}

function exampleLimits() {
  return {
    new_articles_per_day: 1,
    qa_repair_attempts: 3,
    task_retry_attempts: 3,
    max_job_duration_seconds: 1800,
    max_job_cost_jpy: 500,
    max_test_cost_jpy: 0,
    monthly_operating_cost_jpy: 30000,
    slow_down_threshold_percent: 85,
    max_parallel_browser_sessions: 1,
  };
}

function exampleContent() {
  return {
    require_original_value: true,
    require_claim_evidence: true,
    require_primary_source_for_prices: true,
    prohibit_hands_on_claims_in_mvp: true,
    require_price_formula: true,
    require_price_assumptions: true,
    prohibit_fake_human_reviews: true,
    include_clear_ad_disclosure: true,
    affiliate_link_rel: "sponsored",
    price_source_max_age_days: 7,
    feature_source_max_age_days: 30,
    allow_medical_or_financial_advice: false,
    unknown_means_fail: true,
  };
}

function exampleSecurity() {
  return {
    allowed_test_domains: [],
    allowed_source_domains: [],
    allow_captcha_bypass: false,
    allow_auth_bypass: false,
    allow_new_account_creation: false,
    allow_vendor_saas_ui_operations: false,
    allow_payments: false,
    allow_llm_to_modify_policy: false,
    public_pii_redaction_required: true,
    encrypted_evidence_storage: true,
  };
}

function exampleAffiliate() {
  return {
    require_program_approved: true,
    require_offer_active: true,
    require_channel_permission: true,
    treat_pending_as_revenue: false,
  };
}

function exampleOperations() {
  return {
    require_idempotency_keys: true,
    stop_on_unknown_terms: true,
    stop_on_budget_limit: true,
    auto_revoke_on_critical_error: true,
  };
}

function exampleMarket() {
  return {
    enabled: true,
    default_selected_offers: [],
    require_approved_program_for_affiliate_cta: true,
    require_keyword_competition_check: true,
    minimum_intent_keywords_per_category: 10,
    organic_serp_top_n: 10,
    require_country: "JP",
    require_language: "ja",
    unknown_metrics_status: "UNKNOWN",
    exploration_categories: 3,
    initial_research_verticals: [
      "mobile",
      "fiber",
      "buyback",
      "education",
      "career",
      "moving",
      "utilities",
      "water_delivery",
      "car_buyback",
      "saas",
    ],
    default_vertical: null,
    forbid_fabricated_search_volume_or_cvr: true,
  };
}

function minimalPolicy() {
  return {
    version: "v1",
    timezone: "Asia/Tokyo",
    mode: "dry-run",
    flags: exampleFlags(),
    limits: exampleLimits(),
    content: exampleContent(),
    security: exampleSecurity(),
    affiliate: exampleAffiliate(),
    operations: exampleOperations(),
    market_selection: exampleMarket(),
  };
}
