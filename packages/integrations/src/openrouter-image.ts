import { z } from "zod";

export type ImageProviderErrorKind =
  | "auth"
  | "credits"
  | "rate_limited"
  | "transient"
  | "timeout"
  | "permanent";

/** Why an image call failed; `kind` tells the caller whether a retry can help. */
export class ImageProviderError extends Error {
  readonly kind: ImageProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: ImageProviderErrorKind,
    message: string,
    details: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ImageProviderError";
    this.kind = kind;
    if (details.status !== undefined) this.status = details.status;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
  }
}

export interface ImageGenerationRequest {
  prompt: string;
  aspectRatio: string;
  resolution: "1K" | "2K";
}

export interface GeneratedImage {
  bytes: Uint8Array;
  /** Reported by the API when it could identify the format; the bytes are what counts. */
  mediaType: string | undefined;
  /** What this image cost, in USD: the API's own figure, else the configured estimate. */
  costUsd: number;
  model: string;
}

export interface OpenRouterImageConfig {
  apiKey: string;
  model: string;
  /** USD per image, used only when the response carries no cost. */
  estimatedCostUsd: number;
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const ERROR_BODY_LIMIT = 300;

/** docs: https://openrouter.ai/docs/guides/overview/multimodal/image-generation */
const responseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1), media_type: z.string().optional() })).min(1),
  usage: z.object({ cost: z.number().nonnegative().optional() }).optional(),
});

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * Text-to-image through OpenRouter's image API (`POST /images`). Only the
 * base64 bytes in the response are used: a URL in the response is never
 * fetched, so the API cannot point this process at another host.
 */
export class OpenRouterImageProvider {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(private readonly config: OpenRouterImageConfig) {
    if (!config.apiKey) throw new Error("OPENROUTER_API_KEY is required");
    if (!config.model) throw new Error("IMAGE_MODEL is required");
    if (!(config.estimatedCostUsd > 0)) {
      throw new Error("a positive per-image cost estimate is required; calls without a price estimate are forbidden");
    }
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async generate(request: ImageGenerationRequest, signal?: AbortSignal): Promise<GeneratedImage> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/images`, {
        method: "POST",
        ...(signal ? { signal } : {}),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          prompt: request.prompt,
          aspect_ratio: request.aspectRatio,
          resolution: request.resolution,
          n: 1,
        }),
      });
    } catch (error) {
      const aborted = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
      throw new ImageProviderError(aborted ? "timeout" : "transient", this.redact(`image request failed: ${String(error)}`));
    }

    if (!response.ok) throw await this.httpFailure(response);

    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      throw new ImageProviderError("permanent", "image response was not JSON", { status: response.status });
    }
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ImageProviderError("permanent", "image response had no base64 image data", { status: response.status });
    }
    const bytes = new Uint8Array(Buffer.from(parsed.data.data[0]!.b64_json, "base64"));
    if (bytes.length === 0) {
      throw new ImageProviderError("permanent", "image response held an empty image", { status: response.status });
    }
    return {
      bytes,
      mediaType: parsed.data.data[0]!.media_type,
      costUsd: parsed.data.usage?.cost ?? this.config.estimatedCostUsd,
      model: this.config.model,
    };
  }

  private async httpFailure(response: Response): Promise<ImageProviderError> {
    const body = this.redact((await response.text().catch(() => "")).replace(/\s+/g, " ").trim()).slice(0, ERROR_BODY_LIMIT);
    const message = `OpenRouter image API returned HTTP ${response.status}${body ? `: ${body}` : ""}`;
    const status = response.status;
    if (status === 401 || status === 403) return new ImageProviderError("auth", message, { status });
    if (status === 402) return new ImageProviderError("credits", message, { status });
    if (status === 429) {
      const wait = retryAfterMs(response.headers.get("retry-after"));
      return new ImageProviderError("rate_limited", message, { status, ...(wait !== undefined ? { retryAfterMs: wait } : {}) });
    }
    if (status >= 500) return new ImageProviderError("transient", message, { status });
    return new ImageProviderError("permanent", message, { status });
  }

  /** The key must never reach a log line, an error message or a CI summary. */
  private redact(text: string): string {
    return text.split(this.config.apiKey).join("[redacted]");
  }
}
