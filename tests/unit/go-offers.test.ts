import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createMemoryRepository } from "@aff/db";
import { exportGoOffers, goOffersFile } from "../../apps/worker/src/go-offers.js";

const GOOD = "https://px.a8.net/svt/ejp?a8mat=3ABCDE+1FGHIJ+2KLMNO+PQRST";

describe("goOffersFile", () => {
  it("keeps links of the exact A8 tracking shape and counts the rest", () => {
    const file = goOffersFile({
      "offer-a": GOOD,
      "offer-b": "https://evil.example.test/redirect?to=x",
      "offer-c": `${GOOD}&a8ejpredirect=https%3A%2F%2Fevil.example.test`,
      "offer-d": "http://px.a8.net/svt/ejp?a8mat=3ABCDE+1FGHIJ",
    });
    expect(file).toEqual({ file: { offers: { "offer-a": GOOD } }, skipped: 3 });
  });

  it("refuses an offer id that cannot be a path segment of the redirect", () => {
    expect(goOffersFile({ "../x": GOOD, "offer/y": GOOD, "": GOOD })).toEqual({ file: { offers: {} }, skipped: 3 });
  });
});

describe("exportGoOffers", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes the redirect file for the offers that may be monetized, and reports counts only", async () => {
    const repo = createMemoryRepository();
    await repo.offers.upsertProgram({ id: "p", provider: "a8", status: "APPROVED", payoutCurrency: "JPY" });
    const base = { programId: "p", verticalId: "v", rewardModel: "unknown" as const, channelPermissions: ["site" as const], constraints: {} };
    await repo.offers.upsertOffer({ ...base, id: "offer-on", title: "on", active: true, status: "APPROVED" });
    await repo.offers.upsertOffer({ ...base, id: "offer-off", title: "off", active: false, status: "PENDING" });
    await repo.offers.setProgramTrackingUrl("p", GOOD);
    const dir = await mkdtemp(path.join(os.tmpdir(), "go-offers-"));
    dirs.push(dir);
    const out = path.join(dir, "go-offers.json");

    const report = await exportGoOffers(repo, out);

    expect(report).toEqual({ offers: 1, skipped: 0 });
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual({ offers: { "offer-on": GOOD } });
    expect(JSON.stringify(report)).not.toContain("px.a8.net");
  });

  it("writes an empty registry when nothing may be monetized, so the site builds with no redirects", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "go-offers-"));
    dirs.push(dir);
    const out = path.join(dir, "go-offers.json");
    expect(await exportGoOffers(createMemoryRepository(), out)).toEqual({ offers: 0, skipped: 0 });
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual({ offers: {} });
  });
});

describe("the committed redirect file", () => {
  it("stays an empty placeholder: the ad links are written at build time and never committed", async () => {
    const committed = JSON.parse(await readFile(path.join(__dirname, "../../content/go-offers.json"), "utf8")) as { offers: object };
    expect(committed.offers).toEqual({});
  });
});
