import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseA8ProgramsFile } from "@aff/agents";
import { runA8SubmitUrls } from "../../apps/worker/src/a8-submit.js";
import { readFileSync } from "./helpers.js";

const config = parseA8ProgramsFile(readFileSync(new URL("../../config/a8-programs.json", import.meta.url), "utf8"));

describe("runA8SubmitUrls", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("does not log in to A8 when no built page carries a configured brand's ad", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "a8-submit-"));
    dirs.push(dir);
    await mkdir(path.join(dir, "articles/x"), { recursive: true });
    await writeFile(path.join(dir, "articles/x/index.html"), '<link rel="canonical" href="https://site.example.com/articles/x/"><a href="/go/offer-else-x">x</a>', "utf8");
    // No A8_LOGIN_* in the environment: a login attempt would throw, so reaching the answer shows there was none.
    expect(await runA8SubmitUrls({}, { config, distDir: dir })).toEqual({ outcome: "nothing_to_submit", brands: 0, pages: 0 });
  });

  it("does not log in when the site has not been built", async () => {
    expect(await runA8SubmitUrls({}, { config, distDir: path.join(os.tmpdir(), "no-such-dist") })).toEqual({
      outcome: "nothing_to_submit",
      brands: 0,
      pages: 0,
    });
  });
});
