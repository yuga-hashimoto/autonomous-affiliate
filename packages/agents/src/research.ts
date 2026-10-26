import { z } from "zod";
import type { LLMGateway } from "@aff/llm";
import type { Fact, IsoDateTime } from "@aff/domain";
import { htmlToVisibleText, selectRelevantWindows } from "@aff/integrations";

export interface ExtractedFactSpec {
  text: string;
  claimType: Fact["claimType"];
  /** Confidence 0..1 from the extraction method. */
  confidence?: number;
}

/**
 * Extracts structured facts from a fetched source body. Implementations:
 * - deterministic fixture extraction (no LLM, used in dry-run E2E)
 * - LLM-backed extraction (via LLMGateway; validated output)
 */
export interface FactExtractor {
  extract(body: string, contentType: string): Promise<ExtractedFactSpec[]>;
}

const FACTS_BLOCK_TYPE = "application/x-aff-facts";

/**
 * Deterministic extractor: fixture pages embed a JSON fact block:
 * <script type="application/x-aff-facts">[{"text":"...","claimType":"price"}]</script>
 * No interpretation happens — only verbatim structure extraction.
 */
export class FixtureFactExtractor implements FactExtractor {
  async extract(body: string, _contentType?: string): Promise<ExtractedFactSpec[]> {
    const regex = new RegExp(
      `<script[^>]*type="${FACTS_BLOCK_TYPE}"[^>]*>([\\s\\S]*?)</script>`,
      "g",
    );
    const facts: ExtractedFactSpec[] = [];
    for (const match of body.matchAll(regex)) {
      try {
        const parsed: unknown = JSON.parse(match[1]!.trim());
        if (!Array.isArray(parsed)) continue;
        for (const entry of parsed) {
          const spec = entry as Partial<ExtractedFactSpec>;
          if (typeof spec.text === "string" && typeof spec.claimType === "string") {
            facts.push({
              text: spec.text,
              claimType: spec.claimType as Fact["claimType"],
              confidence: typeof spec.confidence === "number" ? spec.confidence : 1,
            });
          }
        }
      } catch {
        // Malformed block → no facts from this block; claims stay UNKNOWN.
      }
    }
    return facts;
  }
}

export const FACT_EXTRACTION_TASK = `Extract factual claims (prices, terms, features) from the official page content.
Return JSON: {"facts":[{"text":"...","claimType":"price|feature|contract_term|cancellation|coverage_area|reward|terms|other"}]}
Rules:
- Only include claims explicitly present in the content. Return an empty array when unsure.
- Make every fact self-contained: name the service, plan or product it applies to, and for prices give the amount, its unit, the tax-inclusive or tax-exclusive label and the billing period or quantity exactly as written (example: "アクアクララ レギュラー12L 2年割プラン: 1本 1,620円（税込・宅配料込み）").
- One claim per fact. Do not compute, calculate, convert or combine numbers; copy them as written.`;

export interface LlmFactOutput {
  facts: { text: string; claimType: Fact["claimType"] }[];
}

export interface LlmExtractorWindowOptions {
  /** Characters of page text per model call. */
  windowChars?: number;
  /** Model calls per page at most. */
  maxWindows?: number;
}

function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * LLM-backed extractor; schema-validated by the gateway. Real pages are
 * reduced to visible text and only the price/contract-heavy windows are sent,
 * so the price table is seen however long the page header and navigation are.
 */
export class LlmFactExtractor implements FactExtractor {
  constructor(
    private readonly gateway: LLMGateway,
    private readonly limits: { timeoutMs: number; maxCostJpy: number; attempts: number },
    private readonly windows: LlmExtractorWindowOptions = {},
  ) {}

  async extract(body: string, contentType = "text/html"): Promise<ExtractedFactSpec[]> {
    const text = htmlToVisibleText(body, contentType);
    const windows = selectRelevantWindows(text, this.windows);
    const facts = new Map<string, ExtractedFactSpec>();
    for (const content of windows) {
      const result = await this.gateway.generateStructured<LlmFactOutput>({
        task: FACT_EXTRACTION_TASK,
        input: { content },
        schema: LLM_FACT_SCHEMA,
        limits: this.limits,
      });
      for (const fact of result.output.facts) {
        const normalized = collapseSpaces(fact.text);
        if (!facts.has(normalized)) {
          facts.set(normalized, { text: normalized, claimType: fact.claimType, confidence: 0.9 });
        }
      }
    }
    return [...facts.values()];
  }
}


const LLM_FACT_SCHEMA = z.object({
  facts: z.array(
    z.object({
      text: z.string().min(1),
      claimType: z.enum([
        "price",
        "contract_term",
        "feature",
        "coverage_area",
        "cancellation",
        "reward",
        "terms",
        "other",
      ]),
    }),
  ),
});

export interface ResearchedFact extends Fact {
  sourceId: string;
}

export function toFact(
  spec: ExtractedFactSpec,
  sourceId: string,
  verifiedAt: IsoDateTime,
  expiresAt: IsoDateTime | undefined,
  newIdFn: (prefix: string) => string,
): Fact {
  return {
    id: newIdFn("fact"),
    text: spec.text,
    claimType: spec.claimType,
    sourceIds: [sourceId],
    verifiedAt,
    confidence: spec.confidence ?? 0.9,
    verificationStatus: "VERIFIED",
    ...(expiresAt ? { expiresAt } : {}),
  };
}
