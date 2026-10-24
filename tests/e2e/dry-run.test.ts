import { execFile } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "../..");
const PREVIEW_DIR = path.join(ROOT, ".tmp/e2e-preview");

interface RunResult {
  results: { slug: string; finalState: string; qaStatus: string; published: boolean }[];
}

async function runWorker(): Promise<RunResult> {
  const { stdout } = await execFileAsync(
    "pnpm",
    ["tsx", "apps/worker/src/index.ts", "run-pipeline", "--out", ".tmp/e2e-preview"],
    { cwd: ROOT, env: { ...process.env, NODE_ENV: "test" } },
  );
  const jsonStart = stdout.indexOf("{");
  return JSON.parse(stdout.slice(jsonStart)) as RunResult;
}

describe("B021/B023 dry-run E2E (source→analysis→draft→QA→preview, no accounts)", () => {
  it(
    "publishes all three fixture comparison articles to preview",
    { timeout: 120000 },
    async () => {
      await rm(PREVIEW_DIR, { recursive: true, force: true });
      const result = await runWorker();
      expect(result.results).toHaveLength(3);
      for (const r of result.results) {
        expect(r.qaStatus).toBe("PASS");
        expect(r.finalState).toBe("PUBLISHED");
        expect(r.published).toBe(true);
      }
      const files = await readdir(path.join(PREVIEW_DIR, "content"));
      expect(files).toHaveLength(3);

      const sim = await readFile(path.join(PREVIEW_DIR, "content", files.find((f) => f.startsWith("sim"))!), "utf8");
      // frontmatter then PR disclosure as the first body line (docs/06)
      expect(sim.startsWith("---\n")).toBe(true);
      const bodyStart = sim.indexOf("---", 4);
      const body = sim.slice(bodyStart + 4).trimStart();
      expect(body.split("\n")[0]).toContain("PR");
      expect(sim).toContain("disclosure:");
      // formula + assumptions present (docs/11 B009 DoD)
      expect(sim).toContain("計算式:");
      expect(sim).toContain("前提:");
      // sources with confirmation date (docs/06)
      expect(sim).toContain("https://sim-a.example.com/price");
      expect(sim).toContain("sha256:");
      // no hands-on claims anywhere
      expect(sim).not.toMatch(/使ってみた|体験した|実測/);
      // approved offer CTA is an internal /go/ link; unapproved offer has none
      expect(sim).toContain("/go/offer-sim-a");
      expect(sim).not.toContain("/go/offer-sim-b");
    },
  );

  it("is idempotent: re-running does not duplicate publications", { timeout: 120000 }, async () => {
    const first = await runWorker();
    const second = await runWorker();
    expect(second.results).toEqual(first.results);
  });
});
