import {
  LLMTimeoutError,
  ProviderAuthError,
  ProviderPermanentError,
  RateLimitedError,
  type CompleteRequest,
  type LLMProvider,
  type ProviderResponse,
} from "./gateway.js";

export interface OpenAiCompatibleConfig {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Mandatory pricing (JPY per 1M tokens) — unpriceable calls are forbidden. */
  inputCostJpyPer1m: number;
  outputCostJpyPer1m: number;
  fetchImpl?: typeof globalThis.fetch;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

/**
 * Minimal OpenAI-compatible chat provider (works with OpenAI, Azure-style
 * gateways, OpenRouter, local vLLM, etc.). Pricing must be configured or the
 * provider refuses to construct — the budget ledger cannot reserve unknowns.
 */
export class OpenAiCompatibleProvider implements LLMProvider {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly config: OpenAiCompatibleConfig) {
    if (!config.apiKey) throw new Error("LLM_API_KEY is required");
    if (!config.model) throw new Error("LLM_MODEL is required");
    if (config.inputCostJpyPer1m <= 0 || config.outputCostJpyPer1m <= 0) {
      throw new Error(
        "LLM token cost rates are required (LLM_INPUT_COST_JPY_PER_1M / LLM_OUTPUT_COST_JPY_PER_1M); calls without a price estimate are forbidden by policy",
      );
    }
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  get id(): string {
    return this.config.providerId;
  }

  get modelId(): string {
    return this.config.model;
  }

  async complete(request: CompleteRequest, signal: AbortSignal): Promise<ProviderResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
          ...(request.system ? [{ role: "system", content: request.system }] : []),
          { role: "user", content: request.prompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: request.limits.maxOutputTokens ?? 2048,
      }),
      });
    } catch (error) {
      if (signal.aborted) throw new LLMTimeoutError(this.config.providerId);
      throw new ProviderPermanentError(this.config.providerId, String(error));
    }
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      const retryAfterDateMs = retryAfterHeader ? Date.parse(retryAfterHeader) - Date.now() : NaN;
      const retryAfterMs = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : Number.isFinite(retryAfterDateMs)
          ? Math.max(0, retryAfterDateMs)
          : null;
      const detail = (await response.text()).slice(0, 400).replace(/[\r\n]+/g, " ").trim();
      throw new RateLimitedError(this.config.providerId, retryAfterMs, detail || undefined);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderAuthError(this.config.providerId, `auth failed (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new ProviderPermanentError(this.config.providerId, `HTTP ${response.status}`);
    }
    const payload = (await response.json()) as ChatCompletionResponse;
    if (payload.error) {
      throw new ProviderPermanentError(this.config.providerId, payload.error.message ?? "unknown error");
    }
    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.length === 0) {
      throw new ProviderPermanentError(this.config.providerId, "empty completion");
    }
    const inputTokens = payload.usage?.prompt_tokens ?? 0;
    const outputTokens = payload.usage?.completion_tokens ?? 0;
    const costJpy = Math.ceil(
      (inputTokens / 1_000_000) * this.config.inputCostJpyPer1m +
        (outputTokens / 1_000_000) * this.config.outputCostJpyPer1m,
    );
    return { text, inputTokens, outputTokens, costJpy, modelId: this.config.model };
  }
}
