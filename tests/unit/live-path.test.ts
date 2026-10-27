import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LivePublisherIO } from "../../apps/worker/src/live-io.js";
import {
  BudgetLedger,
  MockProvider,
  OpenAiCompatibleProvider,
  createGateway,
  mockJson,
} from "@aff/llm";
import { checkRobots, MapFetcher } from "@aff/integrations";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const TMP = path.resolve(__dirname, "../../.tmp/live-io-test");
const CONTENT_DIR = path.join(TMP, "content/articles");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

describe("LivePublisherIO (git publish path)", () => {
  beforeAll(async () => {
    await rm(TMP, { recursive: true, force: true });
    await mkdir(CONTENT_DIR, { recursive: true });
    await git(TMP, "init");
    await git(TMP, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");
  }, 30000);

  it("writes the artifact, builds and commits with a sha", async () => {
    const builds: string[] = [];
    const io = new LivePublisherIO({
      repoRoot: TMP,
      contentDir: CONTENT_DIR,
      buildSite: async () => void builds.push("built"),
    });
    await io.writeArtifact("content/articles/article-a.ja-JP.md", "# hello");
    await io.buildSite();
    const sha = await io.commitArtifact("content/articles/article-a.ja-JP.md", "publish: article-a");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(builds).toEqual(["built"]);
    const stored = await readFile(path.join(CONTENT_DIR, "article-a.ja-JP.md"), "utf8");
    expect(stored).toContain("# hello");
    const committed = await git(TMP, "show", "--name-only", "--format=", "HEAD");
    expect(committed).toContain("content/articles/article-a.ja-JP.md");
  });

  it("rejects artifact paths escaping the content dir", async () => {
    const io = new LivePublisherIO({
      repoRoot: TMP,
      contentDir: CONTENT_DIR,
      buildSite: async () => undefined,
    });
    await expect(
      io.writeArtifact("content/articles/../../evil.md", "nope"),
    ).rejects.toThrow(/escapes/);
  });

  it("commit without changes returns HEAD without failing", async () => {
    const io = new LivePublisherIO({
      repoRoot: TMP,
      contentDir: CONTENT_DIR,
      buildSite: async () => undefined,
    });
    const sha = await io.commitArtifact("content/articles/article-a.ja-JP.md", "duplicate commit");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("pushes the commit only when pushAfterCommit is enabled", async () => {
    const calls: string[][] = [];
    const io = new LivePublisherIO({
      repoRoot: TMP,
      contentDir: CONTENT_DIR,
      pushAfterCommit: true,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
    });
    await io.writeArtifact("content/articles/article-push.md", "# push");
    const sha = await io.commitArtifact("content/articles/article-push.md", "publish");
    expect(sha).toBe("abc123");
    expect(calls.some((c) => c.join(" ").includes("git push origin HEAD:refs/heads/main"))).toBe(true);
  });

  it("reads and removes an article so a failed update can be rolled back", async () => {
    const io = new LivePublisherIO({
      repoRoot: TMP,
      contentDir: CONTENT_DIR,
      buildSite: async () => undefined,
    });
    expect(await io.readArtifact("content/articles/never-written.md")).toBeUndefined();
    await io.writeArtifact("content/articles/article-rollback.md", "# v1");
    expect(await io.readArtifact("content/articles/article-rollback.md")).toBe("# v1");
    await io.removeArtifact("content/articles/article-rollback.md");
    expect(await io.readArtifact("content/articles/article-rollback.md")).toBeUndefined();
    // removing a file that is already gone is not an error
    await io.removeArtifact("content/articles/article-rollback.md");
  });

  it("refuses to read or remove outside the content dir", async () => {
    const io = new LivePublisherIO({
      repoRoot: TMP,
      contentDir: CONTENT_DIR,
      buildSite: async () => undefined,
    });
    await expect(io.readArtifact("content/articles/../../evil.md")).rejects.toThrow(/escapes/);
    await expect(io.removeArtifact("content/articles/../../evil.md")).rejects.toThrow(/escapes/);
  });
});

describe("robots.txt checker", () => {
  it("detects full disallow and specific path rules", async () => {
    const fetcher = new MapFetcher(
      new Map([
        [
          "https://blocked.example.com/robots.txt",
          { body: "User-agent: *\nDisallow: /\n", contentType: "text/plain" },
        ],
        [
          "https://partial.example.com/robots.txt",
          { body: "User-agent: *\nDisallow: /private/\nCrawl-delay: 5\n", contentType: "text/plain" },
        ],
      ]),
    );
    const blocked = await checkRobots(fetcher, "https://blocked.example.com/price");
    expect(blocked.available).toBe(true);
    expect(blocked.disallowsAll).toBe(true);

    const partial = await checkRobots(fetcher, "https://partial.example.com/price");
    expect(partial.disallowsAll).toBe(false);
    expect(partial.starRules.crawlDelaySeconds).toBe(5);
  });

  it("treats missing robots.txt as crawlable-by-convention (ToS still required)", async () => {
    const report = await checkRobots(new MapFetcher(new Map()), "https://none.example.com/page");
    expect(report.available).toBe(false);
    expect(report.disallowsAll).toBe(false);
  });
});

describe("OpenAI-compatible provider", () => {
  const jsonResponse = {
    choices: [{ message: { content: '{"facts":[]}' } }],
    usage: { prompt_tokens: 1000, completion_tokens: 500 },
  };

  function makeProvider(overrides: Partial<ConstructorParameters<typeof OpenAiCompatibleProvider>[0]> = {}) {
    return new OpenAiCompatibleProvider({
      providerId: "test",
      baseUrl: "https://api.example.com/v1",
      apiKey: "k".repeat(20),
      model: "test-model",
      inputCostJpyPer1m: 1000,
      outputCostJpyPer1m: 2000,
      fetchImpl: (async () =>
        new Response(JSON.stringify(jsonResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
      ...overrides,
    });
  }

  it("prices every call from the configured token rates", async () => {
    const provider = makeProvider();
    const controller = new AbortController();
    const result = await provider.complete(
      { task: "t", prompt: "p", limits: { timeoutMs: 1000, maxCostJpy: 0, attempts: 1 } },
      controller.signal,
    );
    // 1000/1M * 1000 + 500/1M * 2000 = 1 + 1 = 2 JPY
    expect(result.costJpy).toBe(2);
    expect(result.modelId).toBe("test-model");
  });

  it("sends the requested output-token limit", async () => {
    let sent: { max_tokens?: number } = {};
    const provider = makeProvider({
      fetchImpl: (async (_url: unknown, init: { body: string }) => {
        sent = JSON.parse(init.body) as { max_tokens?: number };
        return new Response(JSON.stringify(jsonResponse), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await provider.complete(
      { task: "t", prompt: "p", limits: { timeoutMs: 1000, maxCostJpy: 0, attempts: 1, maxOutputTokens: 9000 } },
      new AbortController().signal,
    );
    expect(sent.max_tokens).toBe(9000);
  });

  it("reports a completion cut off by the token limit as truncation, not as bad JSON", async () => {
    const provider = makeProvider({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"facts":[{"text":"cut off mid' }, finish_reason: "length" }],
            usage: { prompt_tokens: 3000, completion_tokens: 2048 },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    await expect(
      provider.complete(
        { task: "t", prompt: "p", limits: { timeoutMs: 1000, maxCostJpy: 0, attempts: 1 } },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/truncated.*finish_reason=length.*completion_tokens/);
  });

  it("refuses to construct without mandatory cost rates", () => {
    expect(() => makeProvider({ inputCostJpyPer1m: 0 })).toThrow(/forbidden/);
    expect(() => makeProvider({ apiKey: "" })).toThrow(/LLM_API_KEY/);
  });

  it("maps 429 to RateLimitedError with Retry-After", async () => {
    const provider = makeProvider({
      fetchImpl: (async () =>
        new Response("{}", { status: 429, headers: { "retry-after": "3" } })) as unknown as typeof fetch,
    });
    await expect(
      provider.complete(
        { task: "t", prompt: "p", limits: { timeoutMs: 1000, maxCostJpy: 0, attempts: 1 } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "RateLimitedError", retryAfterMs: 3000 });
  });

  it("surfaces auth failures as auth errors (no retry, no silent fallback)", async () => {
    const provider = makeProvider({
      fetchImpl: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
    });
    await expect(
      provider.complete(
        { task: "t", prompt: "p", limits: { timeoutMs: 1000, maxCostJpy: 0, attempts: 1 } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "ProviderAuthError" });
  });

  it("gateway falls back when the live provider errors permanently", async () => {
    const failing = makeProvider({
      fetchImpl: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch,
    });
    const fallback = new MockProvider("fallback", "m", [mockJson({ answer: "ok" }, 4)]);
    const ledger = new BudgetLedger(30000, 85);
    const gateway = createGateway({ primary: failing, fallback }, ledger);
    const result = await gateway.generateStructured({
      task: "t",
      input: {},
      schema: z.object({ answer: z.string() }),
      limits: { timeoutMs: 500, maxCostJpy: 10, attempts: 1 },
    });
    expect(result.output).toEqual({ answer: "ok" });
    expect(result.usage.providerId).toBe("fallback");
  });
});
