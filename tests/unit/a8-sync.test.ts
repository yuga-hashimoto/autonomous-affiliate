import { describe, expect, it } from "vitest";
import type { A8Brand } from "@aff/agents";
import { observeBrand, rowMatchesKeyword, type A8Console } from "../../apps/worker/src/a8-sync.js";
import type { HarvestOutcome } from "../../apps/worker/src/a8-harvest.js";
import type { ListState, RawProgramRow } from "../../apps/worker/src/a8-programs.js";

const URL_A = "https://px.a8.net/svt/ejp?a8mat=3ABCDE+1FGHIJ+2KLMNO+PQRST";
const brand: A8Brand = {
  brandSlug: "brand-a",
  keyword: "ブランドA",
  verticalId: "water_delivery",
  termsUrl: "https://brand-a.example.com/affiliate/",
  termsSha256: "a".repeat(64),
  trademarkTerms: ["ブランドA"],
};

const joinedRow = (id: string, name: string): RawProgramRow => ({
  programId: id,
  name,
  text: `${name} 提携中 広告リンク作成`,
  hrefs: [`/program/detail-partnered?programId=${id}`, `/program/create-link?programId=${id}`],
});
const detailOnlyRow = (id: string, name: string): RawProgramRow => ({
  programId: id,
  name,
  text: name,
  hrefs: [`/program/detail-partnered?programId=${id}`],
});

interface Script {
  partnered?: { state: ListState; rows: RawProgramRow[] }[];
  applying?: { state: ListState; rows: RawProgramRow[] };
  harvest?: HarvestOutcome;
  apply?: "applied" | "refused";
}

function fakeConsole(script: Script) {
  const calls = { apply: 0, harvest: [] as string[], partneredReads: 0 };
  const partnered = script.partnered ?? [{ state: "empty" as ListState, rows: [] }];
  const console: A8Console = {
    async readPartnered() {
      const read = partnered[Math.min(calls.partneredReads, partnered.length - 1)]!;
      calls.partneredReads += 1;
      return read;
    },
    async readApplying() {
      return script.applying ?? { state: "empty", rows: [] };
    },
    async harvest(path) {
      calls.harvest.push(path);
      return script.harvest ?? { ok: true, url: URL_A };
    },
    async apply() {
      calls.apply += 1;
      return script.apply ?? "applied";
    },
  };
  return { console, calls };
}

describe("rowMatchesKeyword", () => {
  it("matches on the program's name when the card shows one, not on the rest of the card", () => {
    expect(rowMatchesKeyword(joinedRow("s00000000000001", "ブランドA ウォーター"), "ブランドA")).toBe(true);
    expect(rowMatchesKeyword({ ...joinedRow("s00000000000002", "他社"), text: "他社 ブランドAの類似品" }, "ブランドA")).toBe(false);
  });

  it("falls back to the card text when no name was read", () => {
    expect(rowMatchesKeyword({ programId: "s00000000000003", text: "ブランドA 提携中", hrefs: [] }, "ブランドA")).toBe(true);
  });
});

describe("observeBrand", () => {
  it("reads the ad link of the one joined program that matches", async () => {
    const { console, calls } = fakeConsole({ partnered: [{ state: "programs", rows: [joinedRow("s00000000000001", "ブランドA"), joinedRow("s00000000000002", "他社")] }] });
    const result = await observeBrand(console, brand, true);
    expect(result).toEqual({ observation: { kind: "linked", url: URL_A }, applied: false });
    expect(calls.harvest).toEqual(["/program/create-link?programId=s00000000000001"]);
    expect(calls.apply).toBe(0);
  });

  it("reports why a link could not be read, with the reason only", async () => {
    const { console } = fakeConsole({
      partnered: [{ state: "programs", rows: [joinedRow("s00000000000001", "ブランドA")] }],
      harvest: { ok: false, reason: "site_not_selected" },
    });
    expect((await observeBrand(console, brand, true)).observation).toEqual({ kind: "joined_unreadable", reason: "site_not_selected" });
  });

  it("does not guess between two joined programs of the same name", async () => {
    const { console, calls } = fakeConsole({
      partnered: [{ state: "programs", rows: [joinedRow("s00000000000001", "ブランドA"), joinedRow("s00000000000002", "ブランドA 別プラン")] }],
    });
    expect((await observeBrand(console, brand, true)).observation).toEqual({ kind: "unreadable", reason: "more_than_one_program" });
    expect(calls.harvest).toEqual([]);
    expect(calls.apply).toBe(0);
  });

  it("does not use a program on the list that has no ad-link page", async () => {
    const { console, calls } = fakeConsole({ partnered: [{ state: "programs", rows: [detailOnlyRow("s00000000000001", "ブランドA")] }] });
    expect((await observeBrand(console, brand, true)).observation).toEqual({ kind: "joined_unreadable", reason: "no_ad_link_page" });
    expect(calls.harvest).toEqual([]);
    expect(calls.apply).toBe(0);
  });

  it("stops when the list page was not understood", async () => {
    const { console, calls } = fakeConsole({ partnered: [{ state: "unrecognized", rows: [] }] });
    expect(await observeBrand(console, brand, true)).toEqual({ observation: { kind: "unreadable", reason: "list_unrecognized" }, applied: false });
    expect(calls.apply).toBe(0);
  });

  it("does not apply again while an application is waiting", async () => {
    const { console, calls } = fakeConsole({ applying: { state: "programs", rows: [detailOnlyRow("s00000000000009", "ブランドA")] } });
    expect(await observeBrand(console, brand, true)).toEqual({ observation: { kind: "not_joined", application: "applying" }, applied: false });
    expect(calls.apply).toBe(0);
  });

  it("applies to a program the account has not joined, then looks again in the same run", async () => {
    const { console, calls } = fakeConsole({
      partnered: [
        { state: "empty", rows: [] },
        { state: "programs", rows: [joinedRow("s00000000000001", "ブランドA")] },
      ],
    });
    expect(await observeBrand(console, brand, true)).toEqual({ observation: { kind: "linked", url: URL_A }, applied: true });
    expect(calls.apply).toBe(1);
  });

  it("leaves it as applied when the program is not joined straight after the application", async () => {
    const { console, calls } = fakeConsole({});
    expect(await observeBrand(console, brand, true)).toEqual({ observation: { kind: "not_joined", application: "applied" }, applied: true });
    expect(calls.apply).toBe(1);
  });

  it("does not apply when this run has used its applications", async () => {
    const { console, calls } = fakeConsole({});
    expect(await observeBrand(console, brand, false)).toEqual({ observation: { kind: "not_joined", application: "skipped" }, applied: false });
    expect(calls.apply).toBe(0);
  });

  it("counts a refused application as not made", async () => {
    const { console, calls } = fakeConsole({ apply: "refused" });
    expect(await observeBrand(console, brand, true)).toEqual({ observation: { kind: "not_joined", application: "skipped" }, applied: false });
    expect(calls.apply).toBe(1);
  });
});
