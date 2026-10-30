import { describe, expect, it } from "vitest";
import {
  SCOUT_SEARCHES,
  candidatesFromRows,
  programGate,
  registrableHost,
  siteHostFromDetail,
  slugForHost,
} from "../../apps/worker/src/a8-scout-rules.js";
import type { RawProgramRow } from "../../apps/worker/src/a8-programs.js";

const open = (id: string, name: string, extra = "ウォーターサーバー"): RawProgramRow => ({
  programId: id,
  name,
  text: `${name} ${extra}`.trim(),
  hrefs: [`/program/detail-not-partnered?programId=${id}`],
});

describe("candidatesFromRows", () => {
  it("keeps programs of the vertical that are not configured, with the kind of page they open", () => {
    const rows: RawProgramRow[] = [
      open("s0001", "コスモウォーター"),
      {
        programId: "s0002",
        name: "アクアクララ",
        text: "アクアクララ ウォーターサーバー 提携中",
        hrefs: ["/program/detail-partnered?programId=s0002", "/program/create-link?programId=s0002"],
      },
      open("s0003", "引越し侍", "引越しの一括見積もり"),
      open("s0004", "プレミアムウォーター"),
    ];
    const found = candidatesFromRows(rows, "water_delivery", ["プレミアムウォーター"]);
    expect(found.map((c) => [c.programId, c.name, c.joined])).toEqual([
      ["s0001", "コスモウォーター", false],
      ["s0002", "アクアクララ", true],
    ]);
  });

  it("drops programs that are over or refused, and names the keyword cannot hold", () => {
    const rows: RawProgramRow[] = [
      open("s0001", "コスモウォーター", "ウォーターサーバー プログラム終了"),
      open("s0002", "ウォーターサーバーのとても長い広告主名がここに入っていて四十文字を超えてしまうような名前です"),
      open("s0003", "フレシャス", "ウォーターサーバー 提携不可"),
      open("s0004", "クリクラ"),
    ];
    expect(candidatesFromRows(rows, "water_delivery", []).map((c) => c.programId)).toEqual(["s0004"]);
  });

  it("lists a program once and needs a detail page of its own", () => {
    const noDetail: RawProgramRow = { programId: "s0005", name: "ワンウェイウォーター", text: "ワンウェイウォーター", hrefs: [] };
    const rows = [open("s0001", "コスモウォーター"), open("s0001", "コスモウォーター"), noDetail];
    expect(candidatesFromRows(rows, "water_delivery", []).map((c) => c.programId)).toEqual(["s0001"]);
  });

  it("searches only for the verticals the content path can write about", () => {
    expect(Object.keys(SCOUT_SEARCHES)).toEqual(["water_delivery"]);
  });
});

describe("programGate", () => {
  it("passes a program whose rules do not restrict what a comparison site does", () => {
    const text = "成果地点は新規設置です。比較サイトでの掲載は可能です。口コミの捏造は禁止です。";
    expect(programGate(text)).toEqual({ ok: true, reasons: [] });
  });

  it("rejects a program that forbids comparison, ranking or price statements", () => {
    expect(programGate("他社との比較表現は禁止です。").reasons).toEqual(["restricted_comparison"]);
    expect(programGate("ランキング形式の掲載はご遠慮ください。").reasons).toEqual(["restricted_ranking"]);
    expect(programGate("価格・料金の掲載はできません。").reasons).toEqual(["restricted_price"]);
  });

  it("does not take a rule about search ads for a rule about the page", () => {
    const text = "「ウォーターサーバー 比較」などの複合キーワードでのリスティング出稿は禁止です。";
    expect(programGate(text)).toEqual({ ok: true, reasons: [] });
  });

  it("rejects a program that says it is over", () => {
    expect(programGate("本プログラムは掲載終了しました。").reasons).toContain("program_over");
  });

  it("reads sentence by sentence, so a rule elsewhere on the page does not leak across", () => {
    const text = "比較サイト歓迎。\n不正な申込は禁止です。";
    expect(programGate(text).ok).toBe(true);
  });
});

describe("registrableHost", () => {
  it("keeps the site's own name and drops www and subdomains", () => {
    expect(registrableHost("www.cosmo-water.com")).toBe("cosmo-water.com");
    expect(registrableHost("shop.premium-water.net")).toBe("premium-water.net");
    expect(registrableHost("www.aquaclara.co.jp")).toBe("aquaclara.co.jp");
    expect(registrableHost("EXAMPLE.COM")).toBe("example.com");
  });

  it("returns nothing for an address that is not a host name", () => {
    expect(registrableHost("localhost")).toBeUndefined();
    expect(registrableHost("192.168.0.1")).toBeUndefined();
    expect(registrableHost("")).toBeUndefined();
  });
});

describe("slugForHost", () => {
  it("makes a short ascii slug from the site's name", () => {
    expect(slugForHost("cosmo-water.com")).toBe("cosmo-water");
    expect(slugForHost("aquaclara.co.jp")).toBe("aquaclara");
    expect(slugForHost("water.example.com")).toBe("example");
  });

  it("refuses a name that cannot be a slug", () => {
    expect(slugForHost("xn--eckwd4c7c.jp")).toBeUndefined();
    expect(slugForHost("a-very-long-company-name-that-goes-on-and-on-forever.com")).toBeUndefined();
  });
});

describe("siteHostFromDetail", () => {
  const link = (href: string, text = "") => ({ href, text });

  it("takes the advertiser's site from a link that says it is the site", () => {
    const found = siteHostFromDetail({
      links: [link("/program/search/top", "検索"), link("https://www.cosmo-water.com/", "公式サイト"), link("https://twitter.com/x", "X")],
      text: "",
    });
    expect(found).toEqual({ host: "cosmo-water.com", via: "labeled_link" });
  });

  it("falls back to the only outside link on the page", () => {
    const found = siteHostFromDetail({ links: [link("https://www.cosmo-water.com/lp", "こちら")], text: "" });
    expect(found).toEqual({ host: "cosmo-water.com", via: "only_outside_link" });
  });

  it("does not guess between two sites", () => {
    const found = siteHostFromDetail({
      links: [link("https://www.cosmo-water.com/", "公式サイト"), link("https://www.other-water.com/", "公式サイト")],
      text: "",
    });
    expect(found).toEqual({ via: "ambiguous" });
  });

  it("ignores the ASP's own addresses and social sites", () => {
    const found = siteHostFromDetail({
      links: [link("https://px.a8.net/svt/ejp?a8mat=ABC", "公式サイト"), link("https://support.a8.net/a8/as/faq", "ヘルプ"), link("https://www.youtube.com/watch", "動画")],
      text: "",
    });
    expect(found).toEqual({ via: "none" });
  });

  it("reads a web address written as text when there is no link", () => {
    const found = siteHostFromDetail({ links: [], text: "広告主サイト：https://www.cosmo-water.com/ 成果地点：新規設置" });
    expect(found).toEqual({ host: "cosmo-water.com", via: "address_in_text" });
  });

  it("uses only the host of a link, so an http address still names the site (its pages are read over https)", () => {
    expect(siteHostFromDetail({ links: [link("http://www.cosmo-water.com/", "公式サイト")], text: "" })).toEqual({
      host: "cosmo-water.com",
      via: "labeled_link",
    });
  });

  it("does not take other schemes", () => {
    expect(siteHostFromDetail({ links: [link("javascript:void(0)", "公式サイト"), link("mailto:a@cosmo-water.com", "公式")], text: "" })).toEqual({ via: "none" });
  });
});
