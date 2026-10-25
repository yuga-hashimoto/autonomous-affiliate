import { describe, expect, it } from "vitest";
import { CliLlmProvider, extractJson } from "@aff/llm";
import { LLMTimeoutError, ProviderPermanentError } from "@aff/llm";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";

interface FakeBehavior {
  output?: string;
  stderr?: string;
  exitCode?: number | null;
  hang?: boolean;
  capturedArgs?: string[][];
  capturedStdin?: string[];
}

function makeSpawn(behavior: FakeBehavior) {
  return ((cmd: string, args: string[]) => {
    behavior.capturedArgs ??= [];
    behavior.capturedArgs.push([cmd, ...args]);
    type FakeStream = {
      on(event: "data", cb: (chunk: unknown) => void): void;
      emit(event: "data", chunk: unknown): boolean;
    };
    const stdout: FakeStream = new EventEmitter();
    const stderr: FakeStream = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      stdout: FakeStream;
      stderr: FakeStream;
      stdin: { end(data: string): void };
      kill(): boolean;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = {
      end: (data: string) => {
        behavior.capturedStdin ??= [];
        behavior.capturedStdin.push(data);
      },
    };
    child.kill = () => {
      child.emit("close", null);
      return true;
    };
    queueMicrotask(() => {
      if (behavior.hang) return;
      if (behavior.stderr) stderr.emit("data", behavior.stderr);
      if (behavior.output) stdout.emit("data", behavior.output);
      child.emit("close", behavior.exitCode ?? 0);
    });
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
}

function makeProvider(spawnImpl: typeof spawn, overrides: Record<string, unknown> = {}) {
  return new CliLlmProvider({
    providerId: "cli:opencode",
    command: "opencode",
    args: ["run", "-m", "zai-coding-plan/glm-5.2", "{{PROMPT}}"],
    costJpyPerCall: 20,
    spawnImpl,
    ...overrides,
  });
}

const REQUEST = {
  task: "extract",
  prompt: "return json",
  limits: { timeoutMs: 1000, maxCostJpy: 0, attempts: 1 },
} as const;

describe("CliLlmProvider (opencode/claude/agy adapter)", () => {
  it("replaces the {{PROMPT}} placeholder and prices the call with the allocation", async () => {
    const behavior: FakeBehavior = { output: '{"facts":[]}' };
    const provider = makeProvider(makeSpawn(behavior));
    const result = await provider.complete(REQUEST, new AbortController().signal);
    expect(result.text).toBe('{"facts":[]}');
    expect(result.costJpy).toBe(20);
    expect(behavior.capturedArgs![0]).toEqual([
      "opencode",
      "run",
      "-m",
      "zai-coding-plan/glm-5.2",
      "return json",
    ]);
  });

  it("passes long prompts via stdin in stdin mode", async () => {
    const behavior: FakeBehavior = { output: "ok" };
    const provider = makeProvider(makeSpawn(behavior), {
      args: ["run"],
      useStdin: true,
    });
    const result = await provider.complete(REQUEST, new AbortController().signal);
    expect(result.text).toBe("ok");
    expect(behavior.capturedStdin).toEqual(["return json"]);
  });

  it("rejects placeholder + stdin combination and missing allocation", () => {
    expect(() =>
      makeProvider(makeSpawn({}), { args: ["run", "{{PROMPT}}"], useStdin: true }),
    ).toThrow(/stdin/);
    expect(() => makeProvider(makeSpawn({}), { costJpyPerCall: 0 })).toThrow(/allocation/);
    expect(() => makeProvider(makeSpawn({}), { args: ["run"] })).toThrow(/\{\{PROMPT\}\}/);
  });

  it("maps non-zero exit codes to permanent errors", async () => {
    const provider = makeProvider(makeSpawn({ exitCode: 1, stderr: "boom" }));
    await expect(provider.complete(REQUEST, new AbortController().signal)).rejects.toBeInstanceOf(
      ProviderPermanentError,
    );
  });

  it("aborts to a timeout error and kills the process", async () => {
    const provider = makeProvider(makeSpawn({ hang: true }));
    const controller = new AbortController();
    const pending = provider.complete(REQUEST, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(LLMTimeoutError);
  });
});

describe("extractJson", () => {
  it("parses plain, fenced and prose-wrapped JSON from CLI output", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('Here is the result:\n{"a":{"b":2}}\nDone.')).toBe('{"a":{"b":2}}');
  });
});
