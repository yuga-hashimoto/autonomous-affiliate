import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { READ_PROGRAM_ROWS, readRowsWhenLoaded, type ListPage } from "../../apps/worker/src/a8-programs.js";

// Needs a local Chromium (`playwright install chromium`); without one these tests are skipped.
const browser = await chromium.launch({ headless: true }).catch(() => undefined);
afterAll(async () => {
  await browser?.close();
});

/** A page like the console's: "no data" is on screen first, the rows arrive from a slow request. */
const PAGE = `<!doctype html><body><main>
<div class="noDataArea" id="nd"><p>no data</p></div>
<table><tbody id="rows"></tbody></table></main>
<script>
fetch("/api/rows").then((r) => r.json()).then((list) => {
  document.getElementById("nd").style.display = list.length ? "none" : "block";
  document.getElementById("rows").innerHTML = list.map((id) =>
    '<tr><td><a href="/program/detail?programId=' + id + '">x</a></td>' +
    '<td><a href="/program/create-link?programId=' + id + '">link</a></td></tr>').join("");
});
</script></body>`;

async function serve(rows: string[]): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/rows") {
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(rows));
      }, 1500);
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
}

describe.skipIf(!browser)("readRowsWhenLoaded", () => {
  it("reads the rows that arrive after the page has loaded, where an immediate read sees an empty page", async () => {
    const site = await serve(["s00000001111111", "s00000002222222"]);
    const page = await browser!.newPage();
    try {
      await page.goto(site.url, { waitUntil: "domcontentloaded" });
      const immediate = (await page.evaluate(READ_PROGRAM_ROWS)) as ListPage;
      expect(immediate.rows).toHaveLength(0);
      expect(immediate.noDataShown).toBe(true);

      const patient = await readRowsWhenLoaded(page);
      expect(patient.rows.map((row) => row.programId)).toEqual(["s00000001111111", "s00000002222222"]);
      expect(patient.noDataShown).toBe(false);
    } finally {
      await page.close();
      site.close();
    }
  }, 60_000);

  it("still reports a list that really is empty", async () => {
    const site = await serve([]);
    const page = await browser!.newPage();
    try {
      await page.goto(site.url, { waitUntil: "domcontentloaded" });
      const patient = await readRowsWhenLoaded(page);
      expect(patient.rows).toHaveLength(0);
      expect(patient.noDataShown).toBe(true);
    } finally {
      await page.close();
      site.close();
    }
  }, 60_000);
});
