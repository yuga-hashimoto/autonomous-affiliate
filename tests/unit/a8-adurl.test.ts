import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { adUrlButtonLocator, DUMP_DIALOG_OR_MAIN } from "../../apps/worker/src/a8-adurl.js";
import { renderProbe, type ProbeNode } from "../../apps/worker/src/a8-programs.js";

// Needs a local Chromium (`playwright install chromium`); without one these tests are skipped.
const browser = await chromium.launch({ headless: true }).catch(() => undefined);
afterAll(async () => {
  await browser?.close();
});

/** A partnered list like the console's: cards with an ad-URL button that opens a dialog drawn outside <main>. */
const PAGE = `<!doctype html><body>
<header>メディアID 12345678 サイト名 秘密のサイト</header>
<main>
  <div class="pgCard"><h3 class="pgName">ブランドA</h3><div class="pgAction"><a class="actionAdurl" href="#">広告掲載URL管理</a></div></div>
  <div class="pgCard"><h3 class="pgName">他社</h3><div class="pgAction"><a class="actionAdurl" href="#">広告掲載URL管理</a></div></div>
</main>
<div id="dlg" role="dialog" style="display:none">
  <h2>広告掲載URL管理</h2>
  <form action="/x" method="post"><input type="text" name="adUrl" placeholder="https://example.test/page"><button type="submit">登録</button></form>
  <p>この広告主の注意書きは長い文章でここに入っていて外には出さない</p>
</div>
<script>
document.querySelectorAll(".actionAdurl").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); document.getElementById("dlg").style.display = "block"; }));
</script></body>`;

async function serve(html: string): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
}

describe.skipIf(!browser)("ad-URL button and dialog", () => {
  it("finds the one button on the keyword's own card, and none for a keyword that is not on the page", async () => {
    const site = await serve(PAGE);
    const page = await browser!.newPage();
    try {
      await page.goto(site.url);
      expect(await adUrlButtonLocator(page, "ブランドA").count()).toBe(1);
      expect(await adUrlButtonLocator(page, "どこにもない").count()).toBe(0);
    } finally {
      await page.close();
      site.close();
    }
  });

  it("dumps the dialog the button opens, without the page header, and masks its text", async () => {
    const site = await serve(PAGE);
    const page = await browser!.newPage();
    try {
      await page.goto(site.url);
      await adUrlButtonLocator(page, "ブランドA").click();
      const tree = (await page.evaluate(DUMP_DIALOG_OR_MAIN)) as ProbeNode;
      const lines = renderProbe(tree);
      const text = lines.join("\n");
      expect(text).toContain("input");
      expect(text).toContain("name=adUrl");
      expect(text).toContain('"登録"');
      expect(text).not.toContain("12345678");
      expect(text).not.toContain("秘密のサイト");
      expect(text).not.toContain("注意書き");
    } finally {
      await page.close();
      site.close();
    }
  }, 60_000);

  it("falls back to the page's main content when no dialog opened", async () => {
    const site = await serve(PAGE.replace('style="display:none"', 'style="display:none" data-never="1"'));
    const page = await browser!.newPage();
    try {
      await page.goto(site.url);
      const tree = (await page.evaluate(DUMP_DIALOG_OR_MAIN)) as ProbeNode;
      expect(tree.tag).toBe("main");
    } finally {
      await page.close();
      site.close();
    }
  }, 60_000);
});
