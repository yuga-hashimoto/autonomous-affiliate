import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BudgetExceededError,
  BudgetLedger,
  MockProvider,
  SchemaValidationError,
  createGateway,
  mockJson,
} from "@aff/llm";

const schema = z.object({ answer: z.string() });

function limits(overrides: Partial<{ timeoutMs: number; maxCostJpy: number; attempts: number }> = {}) {
  return { timeoutMs: 200, maxCostJpy: 100, attempts: 3, ...overrides };
}

describe("B005 LLM gateway + budget ledger", () => {
  it("returns schema-validated output and commits actual cost", async () => {
    const provider = new MockProvider("mock-a", "model-a", [mockJson({ answer: "ok" }, 12)]);
    const ledger = new BudgetLedger(30000, 85);
    const gateway = createGateway({ primary: provider }, ledger);
    const result = await gateway.generateStructured({
      task: "classify",
      input: { q: 1 },
      schema,
      limits: limits(),
    });
    expect(result.output).toEqual({ answer: "ok" });
    expect(result.usage.costJpy).toBe(12);
    expect(result.usage.providerId).toBe("mock-a");
    expect(ledger.spentJpy).toBe(12);
    expect(ledger.outstandingReservationJpy).toBe(0);
  });

  it("falls back to the secondary provider when the primary returns invalid JSON", async () => {
    const primary = new MockProvider("p", "m1", [
      { kind: "ok", text: "not-json", costJpy: 1 },
      mockJson({ answer: "bad" }, 1),
    ]);
    const fallback = new MockProvider("f", "m2", [mockJson({ answer: "good" }, 5)]);
    const ledger = new BudgetLedger(30000, 85);
    const gateway = createGateway({ primary, fallback }, ledger);
    const result = await gateway.generateStructured({ task: "t", input: {}, schema, limits: limits() });
    expect(result.output).toEqual({ answer: "good" });
    expect(result.usage.providerId).toBe("f");
    expect(ledger.spentJpy).toBe(5);
  });

  it("retries with backoff after HTTP 429 honoring Retry-After", async () => {
    const provider = new MockProvider("p", "m", [
      { kind: "rate_limited", retryAfterMs: 40, times: 1 },
      mockJson({ answer: "ok" }, 2),
    ]);
    const ledger = new BudgetLedger(30000, 85);
    const sleeps: number[] = [];
    const gateway = createGateway(
      { primary: provider, sleep: (ms) => (sleeps.push(ms), Promise.resolve()) },
      ledger,
    );
    const result = await gateway.generateStructured({ task: "t", input: {}, schema, limits: limits() });
    expect(result.output).toEqual({ answer: "ok" });
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([40]);
  });

  it("times out the primary and falls back", async () => {
    const primary = new MockProvider("slow", "m", [{ kind: "timeout" }]);
    const fallback = new MockProvider("fast", "m", [mockJson({ answer: "ok" }, 3)]);
    const ledger = new BudgetLedger(30000, 85);
    const gateway = createGateway(
      { primary, fallback, sleep: () => Promise.resolve(), backoffBaseMs: 1 },
      ledger,
    );
    const result = await gateway.generateStructured({
      task: "t",
      input: {},
      schema,
      limits: limits({ timeoutMs: 30, attempts: 1 }),
    });
    expect(result.output).toEqual({ answer: "ok" });
    expect(result.usage.providerId).toBe("fast");
  });

  it("blocks the call entirely when the reservation would exceed the monthly budget", async () => {
    const provider = new MockProvider("p", "m", [mockJson({ answer: "ok" }, 1)]);
    const completeSpy = vi.spyOn(provider, "complete");
    const ledger = new BudgetLedger(100, 85);
    const gateway = createGateway({ primary: provider }, ledger);
    await expect(
      gateway.generateStructured({
        task: "t",
        input: {},
        schema,
        limits: limits({ maxCostJpy: 150 }),
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(completeSpy).not.toHaveBeenCalled();
    expect(ledger.spentJpy).toBe(0);
  });

  it("stops when remaining budget is below the reservation after prior spend", async () => {
    const ledger = new BudgetLedger(100, 85, 95);
    const provider = new MockProvider("p", "m", [mockJson({ answer: "ok" }, 10)]);
    const gateway = createGateway({ primary: provider }, ledger);
    await expect(
      gateway.generateStructured({ task: "t", input: {}, schema, limits: limits({ maxCostJpy: 10 }) }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("reports slow-down at the configured threshold", () => {
    expect(new BudgetLedger(1000, 85, 849).shouldSlowDown()).toBe(false);
    expect(new BudgetLedger(1000, 85, 850).shouldSlowDown()).toBe(true);
  });

  it("throws SchemaValidationError when no provider produced valid output", async () => {
    const primary = new MockProvider("p", "m", [{ kind: "ok", text: "garbage" }]);
    const fallback = new MockProvider("f", "m", [{ kind: "ok", text: "{}" }]);
    const ledger = new BudgetLedger(30000, 85);
    const gateway = createGateway({ primary, fallback }, ledger);
    await expect(
      gateway.generateStructured({ task: "t", input: {}, schema, limits: limits({ attempts: 1 }) }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
    expect(ledger.spentJpy).toBe(0);
  });

  it("names the failing field in the error and does not echo the whole prompt", async () => {
    const longTask = `Extract facts\n${"very long instructions ".repeat(100)}`;
    const primary = new MockProvider("p", "m", [mockJson({ answer: 42 })]);
    const gateway = createGateway({ primary }, new BudgetLedger(30000, 85));
    const error = await gateway
      .generateStructured({ task: longTask, input: {}, schema, limits: limits({ attempts: 1 }) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SchemaValidationError);
    const message = (error as Error).message;
    expect(message).toContain("Extract facts");
    expect(message).toContain("answer");
    expect(message.length).toBeLessThan(300);
  });

  it("accepts a schema that normalises loosely-typed model output", async () => {
    const lenient = z.object({ n: z.string() }).transform((value) => ({ n: Number(value.n) }));
    const primary = new MockProvider("p", "m", [mockJson({ n: "5" })]);
    const gateway = createGateway({ primary }, new BudgetLedger(30000, 85));
    const result = await gateway.generateStructured({ task: "t", input: {}, schema: lenient, limits: limits() });
    expect(result.output.n).toBe(5);
  });
});
