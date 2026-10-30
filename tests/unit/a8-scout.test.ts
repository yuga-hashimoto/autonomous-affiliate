import { describe, expect, it } from "vitest";
import { MAX_DETAIL_READS, gatherCandidates, readCandidates, summarize, type DetailPage, type ScoutConsole } from "../../apps/worker/src/a8-scout.js";
import type { RawProgramRow } from "../../apps/worker/src/a8-programs.js";

const card = (id: string, name: string, extra = "ウォーターサーバー"): RawProgramRow => ({
  programId: id,
  name,
  text: `${name} ${extra}`,
  hrefs: [`/program/detail-not-partnered?programId=${id}`],
});

function fakeConsole(searches: Record<string, RawProgramRow[]>, details: Record<string, DetailPage>) {
  const calls = { search: [] as string[], detail: [] as string[] };
  const console: ScoutConsole = {
    async search(keyword) {
      calls.search.push(keyword);
      const rows = searches[keyword] ?? [];
      return { state: rows.length > 0 ? "programs" : "empty", rows };
    },
    async detail(candidate) {
      calls.detail.push(candidate.programId);
      return details[candidate.programId] ?? { text: "", links: [] };
    },
  };
  return { console, calls };
}

describe("gatherCandidates", () => {
  it("searches every keyword of the verticals and counts each card once", async () => {
    const { console, calls } = fakeConsole(
      {
        "ウォーターサーバー": [card("s0001", "コスモウォーター"), card("s0002", "プレミアムウォーター")],
        "宅配水": [card("s0001", "コスモウォーター"), card("s0003", "クリクラ")],
      },
      {},
    );
    const gathered = await gatherCandidates(console, ["プレミアムウォーター"]);
    expect(calls.search).toEqual(["ウォーターサーバー", "宅配水"]);
    expect(gathered.cards).toBe(3);
    expect(gathered.candidates.map((c) => c.programId)).toEqual(["s0001", "s0003"]);
    expect(gathered.unrecognized).toBe(false);
  });

  it("reports a search page it did not understand", async () => {
    const console: ScoutConsole = {
      search: async () => ({ state: "unrecognized", rows: [] }),
      detail: async () => ({ text: "", links: [] }),
    };
    expect((await gatherCandidates(console, [])).unrecognized).toBe(true);
  });
});

describe("readCandidates and summarize", () => {
  it("applies the rules to each detail page and reports counts only", async () => {
    const { console } = fakeConsole(
      { "ウォーターサーバー": [card("s0001", "コスモウォーター"), card("s0002", "クリクラ"), card("s0003", "アクアクララ")] },
      {
        s0001: { text: "比較サイトでの掲載は可能です。", links: [{ href: "https://www.cosmo-water.com/", text: "公式サイト" }] },
        s0002: { text: "他社との比較表現は禁止です。", links: [{ href: "https://www.kurikura.example.com/", text: "公式サイト" }] },
        s0003: { text: "成果地点は新規設置です。", links: [] },
      },
    );
    const gathered = await gatherCandidates(console, []);
    const read = await readCandidates(console, gathered.candidates);
    const report = summarize(gathered, read);
    expect(report).toEqual({
      searches: 2,
      cards: 3,
      candidates: 3,
      joined: 0,
      read: 3,
      passed: 2,
      signals: { readable: 0, withProhibition: 1, mentions: { comparison: 2 } },
      rejected: { restricted_comparison: 1 },
      sites: { labeled_link: 1, none: 1 },
    });
    expect(JSON.stringify(report)).not.toMatch(/コスモ|クリクラ|アクアクララ|cosmo|s0001/);
  });

  it("reads at most a fixed number of pages in one run", async () => {
    const rows = Array.from({ length: MAX_DETAIL_READS + 5 }, (_, i) => card(`s${String(i).padStart(4, "0")}`, `ウォーター${i}号`));
    const { console, calls } = fakeConsole({ "ウォーターサーバー": rows }, {});
    const gathered = await gatherCandidates(console, []);
    await readCandidates(console, gathered.candidates);
    expect(calls.detail).toHaveLength(MAX_DETAIL_READS);
  });
});
