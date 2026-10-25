import type { z } from "zod";
import {
  BudgetExceededError,
  LLMTimeoutError,
  ProviderAuthError,
  ProviderPermanentError,
  RateLimitedError,
  SchemaValidationError,
  type GatewayOptions,
  type LLMGateway,
  type LLMProvider,
  type LLMRequestLimits,
  type StructuredResult,
} from "./gateway.js";

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * CLI agents often wrap JSON in markdown fences or prose. Extract the
 * outermost JSON object so schema validation can judge the actual payload.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1]!.trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) return candidate.slice(start, end + 1);
  return candidate;
}

export class BudgetLedger {
  private committedJpy = 0;
  private reservedJpy = 0;

  constructor(
    public readonly monthlyLimitJpy: number,
    private readonly slowDownThresholdPercent: number,
    /** Already-spent amount persisted for the current month. */
    persistedMonthSpendJpy = 0,
  ) {
    this.committedJpy = persistedMonthSpendJpy;
  }

  get spentJpy(): number {
    return this.committedJpy;
  }

  get outstandingReservationJpy(): number {
    return this.reservedJpy;
  }

  remainingJpy(): number {
    return Math.max(0, this.monthlyLimitJpy - this.committedJpy - this.reservedJpy);
  }

  reserve(amountJpy: number): void {
    if (amountJpy > this.remainingJpy()) {
      throw new BudgetExceededError(amountJpy, this.remainingJpy());
    }
    this.reservedJpy += amountJpy;
  }

  /** Consumes the reservation and records the actual spend. */
  settle(reservedJpy: number, actualJpy: number): number {
    this.reservedJpy = Math.max(0, this.reservedJpy - reservedJpy);
    this.committedJpy += actualJpy;
    return actualJpy;
  }

  refund(reservedJpy: number): void {
    this.reservedJpy = Math.max(0, this.reservedJpy - reservedJpy);
  }

  /** True once the month crosses the slow-down threshold (default 85%). */
  shouldSlowDown(): boolean {
    return this.committedJpy >= (this.monthlyLimitJpy * this.slowDownThresholdPercent) / 100;
  }
}

export function createGateway(options: GatewayOptions, ledger: BudgetLedger): LLMGateway {
  const backoffBaseMs = options.backoffBaseMs ?? 50;
  const sleep = options.sleep ?? defaultSleep;

  async function callProvider(
    provider: LLMProvider,
    prompt: string,
    system: string | undefined,
    limits: { timeoutMs: number; attempts: number },
  ): Promise<{ text: string; usage: { providerId: string; modelId: string; inputTokens: number; outputTokens: number; costJpy: number; latencyMs: number }; attempts: number }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= limits.attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
      const startedAt = Date.now();
      try {
        const response = await provider.complete(
          { task: "", system, prompt, limits: { ...limits, maxCostJpy: 0, attempts: 1 } },
          controller.signal,
        );
        return {
          text: response.text,
          usage: {
            providerId: provider.id,
            modelId: response.modelId,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            costJpy: response.costJpy,
            latencyMs: Date.now() - startedAt,
          },
          attempts: attempt,
        };
      } catch (error) {
        lastError = error;
        if (error instanceof RateLimitedError) {
          // Honor Retry-After when the provider reports it (docs/04).
          await sleep(error.retryAfterMs ?? backoffBaseMs * 2 ** (attempt - 1));
          continue;
        }
        if (error instanceof LLMTimeoutError || error instanceof ProviderPermanentError) {
          if (error instanceof ProviderPermanentError) throw error;
          await sleep(backoffBaseMs * 2 ** (attempt - 1));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error("unreachable");
  }

  return {
    async generateStructured<T>(request: {
      task: string;
      system?: string;
      input: Record<string, unknown>;
      schema: z.ZodType<T>;
      limits: LLMRequestLimits;
    }): Promise<StructuredResult<T>> {
      const { task, system, input, schema, limits } = request;
      // Budget is reserved before any network call (docs/07).
      ledger.reserve(limits.maxCostJpy);
      const prompt = `${task}\n${JSON.stringify(input)}`;
      const providers: LLMProvider[] = options.fallback
        ? [options.primary, options.fallback]
        : [options.primary];
      let lastError: unknown;
      let settled = false;
      try {
        for (const provider of providers) {
          try {
            const outcome = await callProvider(provider, prompt, system, limits);
            const parsed: unknown = JSON.parse(extractJson(outcome.text));
            const validated = schema.safeParse(parsed);
            if (!validated.success) {
              lastError = new SchemaValidationError(task, validated.error.issues);
              continue;
            }
            const committed = ledger.settle(limits.maxCostJpy, outcome.usage.costJpy);
            settled = true;
            return {
              output: validated.data,
              usage: { ...outcome.usage, costJpy: committed },
              attempts: outcome.attempts,
            };
          } catch (error) {
            lastError = error;
            // Auth failures abort the chain; other provider errors try the fallback.
            if (error instanceof ProviderAuthError) throw error;
            continue;
          }
        }
        throw lastError ?? new Error("no llm provider available");
      } finally {
        if (!settled) ledger.refund(limits.maxCostJpy);
      }
    },
  };
}
