import { describe, expect, it } from "vitest";
import {
  conditionFlags,
  isApplyEntryPath,
  isProgramPagePath,
  pickDetailPath,
  siteSelectFlags,
} from "../../apps/worker/src/a8-inspect.js";
import { renderProbe, type ProbeNode, type RawProgramRow } from "../../apps/worker/src/a8-programs.js";

function node(tag: string, overrides: Partial<ProbeNode> = {}): ProbeNode {
  return { tag, cls: [], text: "", children: [], ...overrides };
}

describe("conditionFlags", () => {
  it("reports only booleans for a fixed list of wordings", () => {
    const flags = conditionFlags("掲載後は広告掲載URLを提出してください。提携には審査があります。");
    expect(flags.urlSubmission).toBe(true);
    expect(flags.reviewMentioned).toBe(true);
    expect(flags.instantApproval).toBe(false);
    expect(Object.values(flags).every((value) => typeof value === "boolean")).toBe(true);
  });

  it("recognises instant approval wording", () => {
    expect(conditionFlags("このプログラムは即時提携です").instantApproval).toBe(true);
    expect(conditionFlags("審査はありません").instantApproval).toBe(true);
  });

  it("notes self-purchase and comparison-site wording", () => {
    expect(conditionFlags("ご自身での申込は成果対象外です").selfPurchaseNotice).toBe(true);
    expect(conditionFlags("比較サイトでの掲載も可").comparisonMentioned).toBe(true);
    expect(conditionFlags("リスティング広告は禁止").listingAdMentioned).toBe(true);
  });

  it("is all false for unrelated text", () => {
    expect(Object.values(conditionFlags("こんにちは")).some(Boolean)).toBe(false);
  });
});

describe("isProgramPagePath", () => {
  it.each(["/program/detail?programId=s1", "/program/detail-not-partnered", "/program/apply", "/program/search/result"])(
    "allows %s",
    (path) => {
      expect(isProgramPagePath(path)).toBe(true);
    },
  );

  it.each(["//evil.example/program/x", "https://evil.example/program/x", "/registration-information/quit", "/program/../common/logout", "/program/x/%2e%2e/y", "/home", ""])(
    "refuses %s",
    (path) => {
      expect(isProgramPagePath(path)).toBe(false);
    },
  );

  it.each(["/program/apply/execute", "/program/apply/complete", "/program/apply/submit", "/program/apply/register", "/program/delete"])(
    "refuses a path that sounds like an action: %s",
    (path) => {
      expect(isProgramPagePath(path)).toBe(false);
    },
  );
});

describe("isApplyEntryPath", () => {
  it("accepts only the page that shows the application form", () => {
    expect(isApplyEntryPath("/program/apply?programId=s1")).toBe(true);
    expect(isApplyEntryPath("/program/apply/input")).toBe(true);
    expect(isApplyEntryPath("/program/detail")).toBe(false);
    expect(isApplyEntryPath("/program/apply/execute")).toBe(false);
  });
});

describe("pickDetailPath", () => {
  const row = (hrefs: string[]): RawProgramRow => ({ programId: "s0000001", text: "x", hrefs });

  it("takes the detail link for the same program", () => {
    expect(pickDetailPath(row(["/program/create-link?programId=s0000001", "/program/detail-not-partnered?programId=s0000001"]))).toBe(
      "/program/detail-not-partnered?programId=s0000001",
    );
  });

  it("ignores a detail link for another program and anything outside /program/", () => {
    expect(pickDetailPath(row(["/program/detail?programId=s9999999"]))).toBeUndefined();
    expect(pickDetailPath(row(["https://evil.example/program/detail?programId=s0000001"]))).toBeUndefined();
    expect(pickDetailPath(row(["/other/detail?programId=s0000001"]))).toBeUndefined();
  });
});

describe("siteSelectFlags", () => {
  it("tells whether the target site is offered and whether it is already chosen", () => {
    const options = [
      { text: "別のサイト", selected: true },
      { text: "総額比較【アピールサイト】", selected: false },
    ];
    expect(siteSelectFlags(options, "総額比較")).toEqual({ count: 2, hasTarget: true, defaultIsTarget: false });
  });

  it("is false when the target is missing, so no application can go out for the wrong site", () => {
    expect(siteSelectFlags([{ text: "別のサイト", selected: true }], "総額比較")).toEqual({
      count: 1,
      hasTarget: false,
      defaultIsTarget: false,
    });
    expect(siteSelectFlags([], "総額比較")).toEqual({ count: 0, hasTarget: false, defaultIsTarget: false });
  });
});

describe("renderProbe for pages that carry account and program details", () => {
  it("never prints the options of a site select, which are the account's site names", () => {
    const form = node("form", {
      children: [
        node("select", {
          name: "webSiteId",
          children: [node("option", { text: "秘密のサイトA" }), node("option", { text: "秘密のサイトB" })],
        }),
        node("select", { name: "category", children: [node("option", { text: "総合通販" })] }),
      ],
    });
    const text = renderProbe(form).join("\n");
    expect(text).not.toContain("秘密のサイトA");
    expect(text).not.toContain("秘密のサイトB");
    expect(text).toContain("総合通販");
    expect(text).toContain("webSiteId");
  });

  it("shows where a form posts and with which method, without values", () => {
    const form = node("form", { href: "/program/apply/execute?programId=s0000001", method: "post", children: [] });
    const text = renderProbe(form).join("\n");
    expect(text).toContain("/program/apply/execute?programId=*");
    expect(text).toContain("method=post");
  });

  it("hides a given term wherever it would be printed, such as the program name in a heading", () => {
    const page = node("main", { children: [node("h1", { text: "プレミアムウォーター" }), node("h2", { text: "プレミアムウォーター 提携" })] });
    const text = renderProbe(page, { redact: ["プレミアムウォーター"] }).join("\n");
    expect(text).not.toContain("プレミアムウォーター");
    expect(text).toContain("[term]");
  });

  it("prints only short headings; a long one could be a program name", () => {
    const page = node("main", { children: [node("h1", { text: "提携条件" }), node("h1", { text: "とても長い見出しのテキストでプログラム名かもしれない" })] });
    const text = renderProbe(page).join("\n");
    expect(text).toContain("提携条件");
    expect(text).not.toContain("とても長い");
  });

  it("shows definition terms as labels but not their values", () => {
    const page = node("dl", { children: [node("dt", { text: "報酬" }), node("dd", { text: "10,000円" })] });
    const text = renderProbe(page).join("\n");
    expect(text).toContain("報酬");
    expect(text).not.toContain("10,000");
  });
});
