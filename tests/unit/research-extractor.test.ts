import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { LLMGateway } from "@aff/llm";
import { FACT_EXTRACTION_TASK, LlmFactExtractor } from "@aff/agents";

interface Call {
  task: string;
  content: string;
  maxOutputTokens?: number;
}

/** Records each request and answers with facts keyed by what the content contains. */
function fakeGateway(answer: (content: string) => { text: string; claimType: string }[]): {
  gateway: LLMGateway;
  calls: Call[];
} {
  const calls: Call[] = [];
  const gateway: LLMGateway = {
    async generateStructured<T>(request: {
      task: string;
      input: Record<string, unknown>;
      schema: z.ZodType<T>;
      limits: { maxOutputTokens?: number };
    }) {
      const content = String(request.input.content ?? "");
      calls.push({ task: request.task, content, maxOutputTokens: request.limits.maxOutputTokens });
      const output = request.schema.parse({ facts: answer(content) });
      return { output, provider: "fake", costJpy: 0 } as never;
    },
  };
  return { gateway, calls };
}

const LIMITS = { timeoutMs: 1000, maxCostJpy: 10, attempts: 1 };

/** A real-looking page: >20KB of head/script/navigation before the price table. */
function longPage(): string {
  const nav = Array.from({ length: 600 }, (_, i) => `<li><a href="/menu/${i}">メニュー項目${i}</a></li>`).join("");
  return `<!doctype html><html><head><title>料金 | アクアクララ</title>
    <script>window.__DATA__ = "${"x".repeat(9000)}";</script></head>
    <body><nav><ul>${nav}</ul></nav>
    <main><h1>ご利用料金</h1>
    <table><tr><th>ボトル</th><th>2年割プラン</th></tr>
    <tr><td>レギュラー(12L)</td><td>1,620円（税込・宅配料込）</td></tr></table>
    <p>途中解除料 2年未満 12,980円（税込）。最低契約期間は2年です。</p></main></body></html>`;
}

describe("LlmFactExtractor on real-world HTML", () => {
  it("sends the price section even when it lies beyond the first 8,000 characters", async () => {
    const html = longPage();
    expect(html.indexOf("1,620円")).toBeGreaterThan(8000);
    const { gateway, calls } = fakeGateway(() => []);
    await new LlmFactExtractor(gateway, LIMITS).extract(html, "text/html; charset=utf-8");
    expect(calls.length).toBeGreaterThan(0);
    const sent = calls.map((c) => c.content).join("\n");
    expect(sent).toContain("レギュラー(12L) | 1,620円（税込・宅配料込）");
    expect(sent).toContain("途中解除料 2年未満 12,980円");
    expect(sent).not.toMatch(/<script|<nav|window\.__DATA__/);
  });

  it("allows an answer long enough for a page's dozens of facts (the provider default of 2,048 tokens cuts the JSON off)", async () => {
    const { gateway, calls } = fakeGateway(() => []);
    await new LlmFactExtractor(gateway, LIMITS).extract(longPage(), "text/html");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.maxOutputTokens).toBeGreaterThanOrEqual(8000);
  });

  it("lets the caller set a different output limit", async () => {
    const { gateway, calls } = fakeGateway(() => []);
    await new LlmFactExtractor(gateway, { ...LIMITS, maxOutputTokens: 4096 }).extract(longPage(), "text/html");
    for (const call of calls) expect(call.maxOutputTokens).toBe(4096);
  });

  it("never sends more than the window size per call nor more calls than the window budget", async () => {
    const { gateway, calls } = fakeGateway(() => []);
    await new LlmFactExtractor(gateway, LIMITS, { windowChars: 3000, maxWindows: 2 }).extract(longPage(), "text/html");
    expect(calls.length).toBeLessThanOrEqual(2);
    for (const call of calls) expect(call.content.length).toBeLessThanOrEqual(3000);
  });

  it("merges facts from every window and drops duplicates", async () => {
    const { gateway } = fakeGateway((content) =>
      content.includes("1,620円")
        ? [
            { text: "アクアクララ レギュラー12L 2年割: 1本1,620円（税込）", claimType: "price" },
            { text: "アクアクララ  レギュラー12L 2年割: 1本1,620円（税込）", claimType: "price" },
          ]
        : [],
    );
    const facts = await new LlmFactExtractor(gateway, LIMITS, { windowChars: 2000, maxWindows: 3 }).extract(
      longPage(),
      "text/html",
    );
    expect(facts.map((f) => f.text)).toEqual(["アクアクララ レギュラー12L 2年割: 1本1,620円（税込）"]);
    expect(facts[0]).toMatchObject({ claimType: "price", confidence: 0.9 });
  });

  it("keeps a fact whose type the model invented as 'other' instead of failing the whole page", async () => {
    const { gateway } = fakeGateway((content) =>
      content.includes("1,620円")
        ? [
            { text: "プレミアムウォーター 月額4,082円（税込）", claimType: "promotion" },
            { text: "アクアクララ 月額1,100円（税込）", claimType: "price" },
          ]
        : [],
    );
    const facts = await new LlmFactExtractor(gateway, LIMITS).extract(longPage(), "text/html");
    expect(facts).toEqual([
      { text: "プレミアムウォーター 月額4,082円（税込）", claimType: "other", confidence: 0.9 },
      { text: "アクアクララ 月額1,100円（税込）", claimType: "price", confidence: 0.9 },
    ]);
  });

  it("drops malformed entries but keeps the valid ones", async () => {
    const malformed = [{ claimType: "price" }, { text: "", claimType: "price" }, "plain string", null, 7] as never[];
    const { gateway } = fakeGateway((content) =>
      content.includes("1,620円") ? [...malformed, { text: "アクアクララ 送料0円", claimType: "price" }] : [],
    );
    const facts = await new LlmFactExtractor(gateway, LIMITS).extract(longPage(), "text/html");
    expect(facts.map((f) => f.text)).toEqual(["アクアクララ 送料0円"]);
  });

  it("returns no facts for an empty page without calling the model", async () => {
    const { gateway, calls } = fakeGateway(() => []);
    expect(await new LlmFactExtractor(gateway, LIMITS).extract("<html><body> </body></html>", "text/html")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("asks for self-contained facts that name the service so evidence can be linked", () => {
    expect(FACT_EXTRACTION_TASK).toMatch(/service|plan|product/i);
    expect(FACT_EXTRACTION_TASK).toMatch(/tax/i);
    expect(FACT_EXTRACTION_TASK).toMatch(/do not (compute|calculate|convert)/i);
  });
});
