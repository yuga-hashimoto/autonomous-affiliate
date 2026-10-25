import { spawn } from "node:child_process";
import {
  LLMTimeoutError,
  ProviderPermanentError,
  type CompleteRequest,
  type LLMProvider,
  type ProviderResponse,
} from "./gateway.js";

export interface CliProviderConfig {
  providerId: string;
  /** Executable, e.g. "opencode" | "claude" | "agy". */
  command: string;
  /** Argument list. "{{PROMPT}}" is replaced by the prompt unless stdin is used. */
  args?: string[];
  /** Pass the prompt via stdin instead of argv (recommended: avoids arg-length limits). */
  useStdin?: boolean;
  /** Mandatory conservative allocation per call in JPY. Subscriptions have no
   * per-token price, so a fixed allocation keeps the budget ledger honest. */
  costJpyPerCall: number;
  /** Injectable for tests. */
  spawnImpl?: typeof spawn;
}

/**
 * Provider adapter for local coding-agent CLIs (opencode run / claude -p /
 * agy -p). The prompt goes in via argv placeholder or stdin; stdout is
 * returned as-is and schema-validated by the gateway. No tools, no shell.
 */
export class CliLlmProvider implements LLMProvider {
  private readonly spawnImpl: typeof spawn;

  constructor(private readonly config: CliProviderConfig) {
    if (!config.command) throw new Error("LLM_CLI_COMMAND is required");
    if (config.costJpyPerCall <= 0) {
      throw new Error(
        "LLM_CLI_COST_JPY_PER_CALL must be a positive number; calls without a cost allocation are forbidden by policy",
      );
    }
    if (config.useStdin && (config.args ?? []).includes("{{PROMPT}}")) {
      throw new Error("{{PROMPT}} placeholder must not be used together with stdin mode");
    }
    if (!config.useStdin && !(config.args ?? []).includes("{{PROMPT}}")) {
      throw new Error('LLM_CLI_ARGS must contain "{{PROMPT}}" or LLM_CLI_STDIN=1 must be set');
    }
    this.spawnImpl = config.spawnImpl ?? spawn;
  }

  get id(): string {
    return this.config.providerId;
  }

  get modelId(): string {
    return this.config.providerId;
  }

  async complete(request: CompleteRequest, signal: AbortSignal): Promise<ProviderResponse> {
    const startedAt = Date.now();
    const args = (this.config.args ?? []).map((a) =>
      a === "{{PROMPT}}" ? request.prompt : a,
    );

    return new Promise<ProviderResponse>((resolve, reject) => {
      const child = this.spawnImpl(this.config.command, args, {
        stdio: this.config.useStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(error);
      };
      const succeed = (text: string) => {
        if (settled) return;
        settled = true;
        resolve({
          text,
          inputTokens: 0,
          outputTokens: 0,
          costJpy: this.config.costJpyPerCall,
          modelId: this.config.providerId,
        });
      };

      child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", (error) => fail(new ProviderPermanentError(this.config.providerId, String(error))));
      child.on("close", (code) => {
        if (signal.aborted) {
          fail(new LLMTimeoutError(this.config.providerId));
          return;
        }
        if (code !== 0) {
          fail(
            new ProviderPermanentError(
              this.config.providerId,
              `exit code ${code}: ${stderr.slice(0, 400)}`,
            ),
          );
          return;
        }
        if (stdout.trim().length === 0) {
          fail(new ProviderPermanentError(this.config.providerId, "empty output"));
          return;
        }
        succeed(stdout);
      });

      const onAbort = () => fail(new LLMTimeoutError(this.config.providerId));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      if (this.config.useStdin) {
        child.stdin?.end(request.prompt);
      }
      void startedAt;
    });
  }
}
