import { describe, expect, it } from "vitest";
import { automationBan, restrictionReasons, ruleSignals } from "@aff/agents";

describe("restrictionReasons", () => {
  it("finds a rule against comparison, ranking or price statements", () => {
    expect(restrictionReasons("他社との比較表現は禁止です。")).toEqual(["restricted_comparison"]);
    expect(restrictionReasons("最安などの表現はご遠慮ください。")).toEqual(["restricted_ranking"]);
    expect(restrictionReasons("価格・料金の掲載はできません。")).toEqual(["restricted_price"]);
  });

  it("does not count a rule about search ads or one that permits", () => {
    expect(restrictionReasons("「水 比較」などのキーワードでのリスティング出稿は禁止です。")).toEqual([]);
    expect(restrictionReasons("比較サイトでの掲載は可能です。")).toEqual([]);
  });

  it("finds a program that says it is over", () => {
    expect(restrictionReasons("本プログラムは掲載終了しました。")).toEqual(["program_over"]);
  });
});

describe("automationBan", () => {
  it("finds a rule against collecting the site by program", () => {
    expect(automationBan("当サイトの情報をスクレイピング等により収集することを禁止します。")).toBe(true);
    expect(automationBan("ロボットやクローラによる自動的な取得は禁止します。")).toBe(true);
    expect(automationBan("プログラムを用いてアクセスすることを禁じます。")).toBe(true);
  });

  it("is not set off by an ordinary rule or by the permitted use", () => {
    expect(automationBan("第三者の著作権を侵害する行為を禁止します。")).toBe(false);
    expect(automationBan("お客様は自動的に更新される契約に同意します。")).toBe(false);
    expect(automationBan("")).toBe(false);
  });
});

describe("ruleSignals", () => {
  it("counts sentences with a prohibition and names the topics, not the text", () => {
    const signals = ruleSignals("比較サイトは歓迎です。他社の悪口は禁止です。価格の掲載は可能です。");
    expect(signals).toEqual({ prohibitions: 1, topics: ["comparison", "price"] });
  });
});
