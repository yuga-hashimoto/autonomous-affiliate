import { afterAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import {
  DUMP_TREE,
  READ_PROGRAM_ROWS,
  classifyProgramStatus,
  renderProbe,
  type ListPage,
  type ProbeNode,
} from "../../apps/worker/src/a8-programs.js";

// Needs a local Chromium (`playwright install chromium`); without one these tests are skipped.
const browser = await chromium.launch({ headless: true }).catch(() => undefined);
afterAll(async () => {
  await browser?.close();
});

/**
 * A program card as the console draws it in search results: the name is a heading at the top, the
 * links to the program are lower down in separate blocks, and nothing is a table row or a list item.
 */
const CARD = (id: string, name: string): string => `
<div class="pgCard"><div class="pgInner">
  <div class="pgInnerTop"><div class="pgTitle"><h3 class="pgName">${name}</h3></div></div>
  <div class="pgContent"><div class="pgleft">
    <div class="pgBan"><a class="banAction" href="/program/detail-not-partnered?programId=${id}&fromSearch=1"></a></div>
    <div class="pgStatus statusNotApproval">未提携</div>
  </div></div>
  <div class="pgAction"><a class="btn" href="/program/detail-not-partnered?programId=${id}&fromSearch=1">詳細</a></div>
</div></div>`;

describe.skipIf(!browser)("READ_PROGRAM_ROWS on program cards", () => {
  it("reads the whole card as the row, so the name is part of its text", async () => {
    const page = await browser!.newPage();
    try {
      await page.setContent(
        `<!doctype html><body><main>${CARD("s00000001111111", "ダミー水")}${CARD("s00000002222222", "別のダミー")}</main></body>`,
      );
      const { rows } = (await page.evaluate(READ_PROGRAM_ROWS)) as ListPage;

      expect(rows.map((row) => row.programId)).toEqual(["s00000001111111", "s00000002222222"]);
      expect(rows[0]?.name).toBe("ダミー水");
      expect(rows[1]?.name).toBe("別のダミー");
      expect(rows[0]?.text).toContain("ダミー水");
      expect(rows[0]?.text).not.toContain("別のダミー");
      expect(rows[1]?.text).toContain("別のダミー");
    } finally {
      await page.close();
    }
  });

  it("collects every link of the card, such as the page that makes ad links", async () => {
    const page = await browser!.newPage();
    try {
      await page.setContent(
        `<!doctype html><body><main><div class="pgCard"><h3>x</h3>
         <a href="/program/detail?programId=s00000003333333">d</a>
         <div class="pgAction"><a href="/program/create-link?programId=s00000003333333">link</a></div></div></main></body>`,
      );
      const { rows } = (await page.evaluate(READ_PROGRAM_ROWS)) as ListPage;
      expect(rows).toHaveLength(1);
      expect(classifyProgramStatus(rows[0]?.text ?? "", rows[0]?.hrefs ?? [])).toBe("approved");
    } finally {
      await page.close();
    }
  });

  it("prints the page structure of cards without any program name, long or short", async () => {
    const page = await browser!.newPage();
    try {
      await page.setContent(
        `<!doctype html><body><main><h1>キーワード検索</h1>${CARD("s00000001111111", "短い名前")}${CARD(
          "s00000002222222",
          "とても長いプログラム名がここに入っていますよ【ダミー】",
        )}</main></body>`,
      );
      const text = renderProbe((await page.evaluate(DUMP_TREE)) as ProbeNode, { redact: ["ダミー"] }).join("\n");

      expect(text).toContain("キーワード検索");
      expect(text).toContain("pgName");
      for (const hidden of ["短い名前", "とても長い", "s00000001111111", "s00000002222222", "未提携"]) {
        expect(text).not.toContain(hidden);
      }
    } finally {
      await page.close();
    }
  });
});
