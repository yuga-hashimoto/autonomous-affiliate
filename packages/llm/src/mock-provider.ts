import {
  LLMTimeoutError,
  ProviderPermanentError,
  RateLimitedError,
  type CompleteRequest,
  type LLMProvider,
  type ProviderResponse,
} from "./gateway.js";

export type MockBehavior =
  | {
      kind: "ok";
      text: string;
      inputTokens?: number;
      outputTokens?: number;
      costJpy?: number;
      latencyMs?: number;
    }
  | { kind: "rate_limited"; retryAfterMs?: number; times?: number }
  | { kind: "timeout" }
  | { kind: "error"; detail?: string };

export function mockJson(value: unknown, costJpy = 1): MockBehavior {
  return { kind: "ok", text: JSON.stringify(value), costJpy };
}

/** Deterministic scripted provider for tests and offline dry-runs. */
export class MockProvider implements LLMProvider {
  private queue: MockBehavior[];

  constructor(
    public readonly id: string,
    public readonly modelId: string,
    behaviors: MockBehavior[],
  ) {
    this.queue = [...behaviors];
  }

  async complete(
    _request: CompleteRequest,
    signal: AbortSignal,
  ): Promise<ProviderResponse> {
    const behavior = this.queue.length > 1 ? this.queue.shift()! : this.queue[0]!;
    switch (behavior.kind) {
      case "ok":
        return {
          text: behavior.text,
          inputTokens: behavior.inputTokens ?? 100,
          outputTokens: behavior.outputTokens ?? 200,
          costJpy: behavior.costJpy ?? 1,
          modelId: this.modelId,
        };
      case "rate_limited": {
        if ((behavior.times ?? 1) > 0 && this.queue.length > 1) {
          this.queue.splice(0, 1); // consume one occurrence
        }
        throw new RateLimitedError(this.id, behavior.retryAfterMs ?? null);
      }
      case "timeout":
        return new Promise<ProviderResponse>((_resolve, reject) => {
          const onAbort = () => reject(new LLMTimeoutError(this.id));
          if (signal.aborted) onAbort();
          signal.addEventListener("abort", onAbort, { once: true });
        });
      case "error":
        throw new ProviderPermanentError(this.id, behavior.detail ?? "server error");
    }
  }
}
