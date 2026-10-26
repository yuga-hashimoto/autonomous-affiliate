import type { z } from "zod";

export interface LLMUsage {
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costJpy: number;
  latencyMs: number;
}

export interface LLMRequestLimits {
  timeoutMs: number;
  maxCostJpy: number;
  attempts: number;
  /** Hard output-token ceiling sent to API providers. Defaults to 2048. */
  maxOutputTokens?: number;
}

export interface StructuredResult<T> {
  output: T;
  usage: LLMUsage;
  /** Provider chain actually used; falls back happen left to right. */
  attempts: number;
}

export interface CompleteRequest {
  task: string;
  system?: string;
  prompt: string;
  limits: LLMRequestLimits;
}

export interface ProviderResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costJpy: number;
  modelId: string;
}

export class LLMTimeoutError extends Error {
  constructor(public readonly providerId: string) {
    super(`llm provider ${providerId} timed out`);
    this.name = "LLMTimeoutError";
  }
}

export class RateLimitedError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly retryAfterMs: number | null,
    detail?: string,
  ) {
    super(`llm provider ${providerId} rate limited (HTTP 429)${detail ? `: ${detail}` : ""}`);
    this.name = "RateLimitedError";
  }
}

export class ProviderPermanentError extends Error {
  constructor(
    public readonly providerId: string,
    detail: string,
  ) {
    super(`llm provider ${providerId} failed permanently: ${detail}`);
    this.name = "ProviderPermanentError";
  }
}

/** Auth/permission failures must never silently fall back to another provider. */
export class ProviderAuthError extends ProviderPermanentError {
  constructor(providerId: string, detail: string) {
    super(providerId, detail);
    this.name = "ProviderAuthError";
  }
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly requiredJpy: number,
    public readonly remainingJpy: number,
  ) {
    super(
      `budget exceeded: estimated ${requiredJpy} JPY but only ${remainingJpy} JPY remains this month`,
    );
    this.name = "BudgetExceededError";
  }
}

const ISSUES_IN_MESSAGE = 3;
const TASK_LABEL_CHARS = 80;

export class SchemaValidationError extends Error {
  constructor(
    task: string,
    public readonly issues: z.ZodIssue[],
  ) {
    // The task is the whole prompt; name it by its first line and say which fields failed.
    const label = (task.split("\n")[0] ?? "").slice(0, TASK_LABEL_CHARS);
    const shown = issues
      .slice(0, ISSUES_IN_MESSAGE)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    const more = issues.length > ISSUES_IN_MESSAGE ? ` (+${issues.length - ISSUES_IN_MESSAGE} more)` : "";
    super(`llm output failed schema validation for task "${label}": ${shown}${more}`);
    this.name = "SchemaValidationError";
  }
}

/** Single model endpoint. Implementations must not retry internally. */
export interface LLMProvider {
  readonly id: string;
  readonly modelId: string;
  complete(request: CompleteRequest, signal: AbortSignal): Promise<ProviderResponse>;
}

/**
 * Model-agnostic gateway (ADR-003): structured generation with schema
 * validation, timeout, bounded retries with backoff, provider fallback and
 * budget reservation before every call.
 */
export interface LLMGateway {
  generateStructured<T>(request: {
    task: string;
    system?: string;
    input: Record<string, unknown>;
    /** Input is unknown so a schema may normalise loosely-typed model output (transform, catch). */
    schema: z.ZodType<T, z.ZodTypeDef, unknown>;
    limits: LLMRequestLimits;
  }): Promise<StructuredResult<T>>;
}

export interface GatewayOptions {
  primary: LLMProvider;
  fallback?: LLMProvider;
  /** Milliseconds between retry attempts; grows exponentially. */
  backoffBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}
