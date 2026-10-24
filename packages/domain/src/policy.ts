import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const VERTICAL_IDS = [
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
] as const;
export const verticalIdSchema = z.enum(VERTICAL_IDS);
export type VerticalId = (typeof VERTICAL_IDS)[number];

const domainSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9.-]+(:\d+)?$/i, "must be a hostname (optionally with port), no scheme or path");

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

const flagsSchema = z
  .strictObject({
    research_enabled: z.boolean(),
    browser_testing_enabled: z.boolean(),
    analysis_enabled: z.boolean(),
    publish_enabled: z.boolean(),
    youtube_enabled: z.boolean(),
    social_enabled: z.boolean(),
    paid_ads_enabled: z.boolean(),
    affiliate_links_enabled: z.boolean(),
  })
  .superRefine((flags, ctx) => {
    if (flags.paid_ads_enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paid_ads_enabled"],
        message: "paid ads must stay disabled: irreversible spend is not allowed for the operator",
      });
    }
  });

const limitsSchema = z
  .strictObject({
    new_articles_per_day: positiveInt,
    qa_repair_attempts: positiveInt,
    task_retry_attempts: positiveInt,
    max_job_duration_seconds: positiveInt,
    max_job_cost_jpy: nonNegativeInt,
    max_test_cost_jpy: z.literal(0),
    monthly_operating_cost_jpy: nonNegativeInt,
    slow_down_threshold_percent: z.number().int().min(1).max(100),
    max_parallel_browser_sessions: nonNegativeInt,
  })
  .superRefine((limits, ctx) => {
    if (limits.max_job_cost_jpy > limits.monthly_operating_cost_jpy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max_job_cost_jpy"],
        message: "per-job cost cap must not exceed the monthly operating cap",
      });
    }
  });

const contentSchema = z.strictObject({
  require_original_value: z.literal(true),
  require_claim_evidence: z.literal(true),
  require_primary_source_for_prices: z.literal(true),
  prohibit_hands_on_claims_in_mvp: z.literal(true),
  require_price_formula: z.literal(true),
  require_price_assumptions: z.literal(true),
  prohibit_fake_human_reviews: z.literal(true),
  include_clear_ad_disclosure: z.literal(true),
  affiliate_link_rel: z.enum(["sponsored"]),
  price_source_max_age_days: positiveInt,
  feature_source_max_age_days: positiveInt,
  allow_medical_or_financial_advice: z.literal(false),
  unknown_means_fail: z.literal(true),
});

const securitySchema = z.strictObject({
  allowed_test_domains: z.array(domainSchema),
  allowed_source_domains: z.array(domainSchema),
  allow_captcha_bypass: z.literal(false),
  allow_auth_bypass: z.literal(false),
  allow_new_account_creation: z.literal(false),
  allow_vendor_saas_ui_operations: z.literal(false),
  allow_payments: z.literal(false),
  allow_llm_to_modify_policy: z.literal(false),
  public_pii_redaction_required: z.literal(true),
  encrypted_evidence_storage: z.literal(true),
});

const affiliateSchema = z.strictObject({
  require_program_approved: z.literal(true),
  require_offer_active: z.literal(true),
  require_channel_permission: z.literal(true),
  treat_pending_as_revenue: z.literal(false),
});

const operationsSchema = z.strictObject({
  require_idempotency_keys: z.literal(true),
  stop_on_unknown_terms: z.literal(true),
  stop_on_budget_limit: z.literal(true),
  auto_revoke_on_critical_error: z.literal(true),
});

const marketSelectionSchema = z.strictObject({
  enabled: z.boolean(),
  default_selected_offers: z.array(z.string()),
  require_approved_program_for_affiliate_cta: z.literal(true),
  require_keyword_competition_check: z.literal(true),
  minimum_intent_keywords_per_category: positiveInt,
  organic_serp_top_n: positiveInt,
  require_country: z.literal("JP"),
  require_language: z.literal("ja"),
  unknown_metrics_status: z.literal("UNKNOWN"),
  exploration_categories: positiveInt,
  initial_research_verticals: z.array(verticalIdSchema).min(1),
  default_vertical: z.null(),
  forbid_fabricated_search_volume_or_cvr: z.literal(true),
});

export const policySchema = z.strictObject({
  version: z.string().regex(/^v\d+$/, "policy version must look like v1, v2, ..."),
  timezone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "unknown IANA timezone"),
  mode: z.enum(["dry-run", "live"]),
  flags: flagsSchema,
  limits: limitsSchema,
  content: contentSchema,
  security: securitySchema,
  affiliate: affiliateSchema,
  operations: operationsSchema,
  market_selection: marketSelectionSchema,
});

export type PolicyConfig = z.infer<typeof policySchema>;

export class PolicyValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

function formatIssues(issues: z.ZodIssue[]): string {
  return issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function parsePolicyText(yamlText: string): PolicyConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new PolicyValidationError(`policy YAML is not parseable: ${String(error)}`, []);
  }
  return parsePolicy(raw);
}

export function parsePolicy(raw: unknown): PolicyConfig {
  const result = policySchema.safeParse(raw);
  if (!result.success) {
    throw new PolicyValidationError(
      `policy validation failed: ${formatIssues(result.error.issues)}`,
      result.error.issues,
    );
  }
  return result.data;
}
