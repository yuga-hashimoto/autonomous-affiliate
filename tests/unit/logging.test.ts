import { describe, expect, it } from "vitest";
import { createLogger, redactString, redactValue, redactUrl } from "@aff/domain";

function collect(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe("B004 secret redaction", () => {
  it("never emits API keys, tokens, emails or database URLs", () => {
    const { lines, sink } = collect();
    const log = createLogger({ sink, level: "debug" });
    log.info("job input", {
      apiKey: "sk-abcdef1234567890abcdef",
      githubToken: "ghp_abcdefghijklmnopqrstuvwx",
      awsKey: "AKIAIOSFODNN7EXAMPLE",
      dbUrl: "postgresql://user:secretpw@db.example.com:5432/app",
      contact: "taro.yamada@example.com",
      auth: "Bearer abcdefghijklmnop",
      nested: { password: "hunter2", memo: "reach me at hanako@example.ne.jp" },
    });
    const all = lines.join("\n");
    expect(all).not.toContain("sk-abcdef1234567890abcdef");
    expect(all).not.toContain("ghp_abcdefghijklmnopqrstuvwx");
    expect(all).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(all).not.toContain("secretpw");
    expect(all).not.toContain("taro.yamada@example.com");
    expect(all).not.toContain("abcdefghijklmnop");
    expect(all).not.toContain("hunter2");
    expect(all).not.toContain("hanako@example.ne.jp");
    expect(all).toContain("[REDACTED]");
  });

  it("redacts secrets inside error objects", () => {
    const { lines, sink } = collect();
    const log = createLogger({ sink });
    const err = new Error("call failed with token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c");
    log.error("llm call failed", { error: err });
    const all = lines.join("\n");
    expect(all).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(all).toContain("[REDACTED]");
  });

  it("redacts sensitive URL query params", () => {
    expect(redactUrl("https://asp.example.com/click?aff=123&token=supersecret&id=9")).toBe(
      "https://asp.example.com/click?aff=123&token=%5BREDACTED%5D&id=9",
    );
    expect(redactUrl("https://example.com/plain")).toBe("https://example.com/plain");
    expect(redactString("not an email but key=zzzz is a plain word, mailto: a@b.co")).toContain(
      "a@b.co".slice(0, 2) + "[REDACTED]",
    );
  });

  it("child loggers keep the same trace id and merge fields", () => {
    const { lines, sink } = collect();
    const log = createLogger({ sink });
    const child = log.child({ job: "research" });
    child.info("started");
    const parsed = JSON.parse(lines[0]!) as { trace_id: string; job: string; message: string };
    expect(parsed.trace_id).toBe(log.traceId);
    expect(parsed.job).toBe("research");
    expect(parsed.message).toBe("started");
  });

  it("redactValue handles arrays and deep nesting", () => {
    const out = redactValue([{ api_key: "xyz", note: "mail: yu@example.com" }]) as Array<{
      api_key: string;
      note: string;
    }>;
    expect(out[0]!.api_key).toBe("[REDACTED]");
    expect(out[0]!.note).not.toContain("yu@example.com");
  });
});
