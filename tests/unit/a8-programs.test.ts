import { describe, expect, it } from "vitest";
import {
  classifyProgramStatus,
  hrefShape,
  parseProgramRows,
  programIdOf,
  renderProbe,
  summarizePrograms,
  type ProbeNode,
  type RawProgramRow,
} from "../../apps/worker/src/a8-programs.js";

function node(tag: string, overrides: Partial<ProbeNode> = {}): ProbeNode {
  return { tag, cls: [], text: "", children: [], ...overrides };
}

describe("programIdOf", () => {
  it("reads the programId from a console link", () => {
    expect(programIdOf("/program/create-link?programId=s00000004657008")).toBe("s00000004657008");
    expect(programIdOf("https://media-console.a8.net/program/detail?x=1&programId=s123456&y=2")).toBe("s123456");
  });

  it("returns undefined when there is no usable id", () => {
    expect(programIdOf("/program/list/partnered")).toBeUndefined();
    expect(programIdOf("/program/detail?programId=")).toBeUndefined();
    expect(programIdOf("/program/detail?programId=../../etc/passwd")).toBeUndefined();
    expect(programIdOf("not a url at all")).toBeUndefined();
  });
});

describe("hrefShape", () => {
  it("keeps the path and the query keys but never the values", () => {
    expect(hrefShape("/program/create-link?programId=s00000004657008&websiteId=abc")).toBe(
      "/program/create-link?programId=*&websiteId=*",
    );
  });

  it("replaces id-like path segments", () => {
    expect(hrefShape("/program/detail/s00000004657008/info")).toBe("/program/detail/:id/info");
  });

  it("hides where an outside link points", () => {
    expect(hrefShape("https://advertiser.example.com/secret?x=1")).toBe("(external)");
  });

  it("is safe on junk and on empty links", () => {
    expect(hrefShape("")).toBe("(none)");
    expect(hrefShape("javascript:void(0)")).toBe("(script)");
    expect(hrefShape("#top")).toBe("#");
  });
});

describe("classifyProgramStatus", () => {
  const withLink = ["/program/create-link?programId=s1"];

  it("calls a row with an ad-link page and no warning words approved", () => {
    expect(classifyProgramStatus("株式会社サンプル 提携中", withLink)).toBe("approved");
    expect(classifyProgramStatus("株式会社サンプル", withLink)).toBe("approved");
  });

  it("recognises pending, rejected and ended wording", () => {
    expect(classifyProgramStatus("株式会社サンプル 提携申請中", [])).toBe("pending");
    expect(classifyProgramStatus("株式会社サンプル 審査中", [])).toBe("pending");
    expect(classifyProgramStatus("株式会社サンプル 却下", [])).toBe("rejected");
    expect(classifyProgramStatus("株式会社サンプル 提携不可", withLink)).toBe("rejected");
    expect(classifyProgramStatus("株式会社サンプル プログラム終了", withLink)).toBe("ended");
    expect(classifyProgramStatus("株式会社サンプル 提携解除", withLink)).toBe("ended");
  });

  it("lets a stop word win over an ad-link page, so an ended program is never used", () => {
    expect(classifyProgramStatus("提携中 掲載停止", withLink)).toBe("ended");
  });

  it("does not guess: no ad-link page and no known word is unknown", () => {
    expect(classifyProgramStatus("株式会社サンプル", [])).toBe("unknown");
  });
});

describe("parseProgramRows and summarizePrograms", () => {
  const rows: RawProgramRow[] = [
    { programId: "s0000001", text: "A社 提携中", hrefs: ["/program/create-link?programId=s0000001"] },
    { programId: "s0000002", text: "B社 提携中", hrefs: ["/program/create-link?programId=s0000002"] },
    { programId: "s0000003", text: "C社 プログラム終了", hrefs: ["/program/create-link?programId=s0000003"] },
    { programId: "s0000004", text: "D社", hrefs: [] },
    { programId: "s0000002", text: "B社 提携中 (duplicate)", hrefs: ["/program/create-link?programId=s0000002"] },
  ];

  it("keeps one entry per program and drops the text", () => {
    const programs = parseProgramRows(rows);
    expect(programs.map((program) => program.programId)).toEqual(["s0000001", "s0000002", "s0000003", "s0000004"]);
    expect(JSON.stringify(programs)).not.toContain("A社");
  });

  it("counts programs by status without naming any", () => {
    const summary = summarizePrograms(parseProgramRows(rows));
    expect(summary).toEqual({
      total: 4,
      approved: 2,
      pending: 0,
      rejected: 0,
      ended: 1,
      unknown: 1,
      withAdLinkPage: 3,
    });
  });

  it("ignores rows whose id is not usable", () => {
    expect(parseProgramRows([{ programId: "../x", text: "x", hrefs: [] }])).toEqual([]);
  });
});

describe("renderProbe", () => {
  const table = node("table", {
    children: [
      node("thead", { children: [node("tr", { children: [node("th", { text: "プログラム名" }), node("th", { text: "承認日" })] })] }),
      node("tbody", {
        children: [
          node("tr", {
            cls: ["row"],
            children: [
              node("td", {
                children: [
                  node("a", {
                    text: "秘密の広告主名",
                    href: "/program/detail?programId=s00000004657008",
                  }),
                ],
              }),
              node("td", { text: "成果報酬 5,000円 提携中" }),
            ],
          }),
        ],
      }),
    ],
  });

  it("shows interface labels such as column headings", () => {
    const text = renderProbe(table).join("\n");
    expect(text).toContain("th");
    expect(text).toContain("プログラム名");
    expect(text).toContain("承認日");
  });

  it("masks cell text and link text, so no program name, reward or id reaches the log", () => {
    const text = renderProbe(table).join("\n");
    expect(text).not.toContain("秘密の広告主名");
    expect(text).not.toContain("5,000");
    expect(text).not.toContain("s00000004657008");
    expect(text).toContain("/program/detail?programId=*");
  });

  it("still tells which status words a cell contains, from a fixed vocabulary", () => {
    expect(renderProbe(table).join("\n")).toContain("提携中");
  });

  it("shows short menu links outside cells with their destination", () => {
    const menu = node("nav", {
      children: [node("a", { text: "提携申請中", href: "/program/list/applying" }), node("a", { text: "ホーム", href: "/home" })],
    });
    const text = renderProbe(menu).join("\n");
    expect(text).toContain("提携申請中");
    expect(text).toContain("/program/list/applying");
    expect(text).toContain("ホーム");
  });

  it("masks a long link outside cells, which could be a program name", () => {
    const menu = node("div", {
      children: [node("a", { text: "とても長いプログラム名のリンクテキストですここは伏せる", href: "/program/detail?programId=s1" })],
    });
    expect(renderProbe(menu).join("\n")).not.toContain("とても長い");
  });

  it("describes form controls by name and type", () => {
    const form = node("form", { children: [node("select", { name: "webSiteId", children: [node("option", { text: "総額比較" })] })] });
    const text = renderProbe(form).join("\n");
    expect(text).toContain("select");
    expect(text).toContain("webSiteId");
  });

  it("caps the number of lines", () => {
    const wide = node("ul", { children: Array.from({ length: 2000 }, () => node("li")) });
    expect(renderProbe(wide).length).toBeLessThanOrEqual(601);
  });
});
