import { z } from "zod";
import type { LLMGateway } from "@aff/llm";
import type { Fact, IsoDateTime } from "@aff/domain";

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
Only include claims explicitly present in the content. Return an empty array when unsure.`;

export interface LlmFactOutput {
  facts: { text: string; claimType: Fact["claimType"] }[];
}

/** LLM-backed extractor; schema-validated by the gateway. */
export class LlmFactExtractor implements FactExtractor {
  constructor(
    private readonly gateway: LLMGateway,
    private readonly limits: { timeoutMs: number; maxCostJpy: number; attempts: number },
  ) {}

  async extract(body: string): Promise<ExtractedFactSpec[]> {
    const result = await this.gateway.generateStructured<LlmFactOutput>({
      task: FACT_EXTRACTION_TASK,
      input: { content: body.slice(0, 8000) },
      schema: LLM_FACT_SCHEMA,
      limits: this.limits,
    });
    return result.output.facts.map((f) => ({ text: f.text, claimType: f.claimType, confidence: 0.9 }));
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
