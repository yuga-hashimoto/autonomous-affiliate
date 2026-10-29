import { describe, expect, it } from "vitest";
import { pickCreateLinkPath } from "../../apps/worker/src/a8-linkpage.js";
import type { RawProgramRow } from "../../apps/worker/src/a8-programs.js";

const row = (programId: string, hrefs: string[]): RawProgramRow => ({ programId, text: "x", hrefs });

describe("pickCreateLinkPath", () => {
  it("returns the row's own ad-link page, as a path and query", () => {
    const r = row("s00000000000001", ["/program/detail-partnered?programId=s00000000000001", "/program/create-link?programId=s00000000000001"]);
    expect(pickCreateLinkPath(r)).toBe("/program/create-link?programId=s00000000000001");
  });

  it("does not take another program's page", () => {
    expect(pickCreateLinkPath(row("s00000000000001", ["/program/create-link?programId=s00000000000002"]))).toBeUndefined();
  });

  it("does not take the goods-link page, another origin, or a path trick", () => {
    for (const href of [
      "/program/create-goods-link?programId=s00000000000001",
      "https://example.test/program/create-link?programId=s00000000000001",
      "//example.test/program/create-link?programId=s00000000000001",
      "/program/create-link/../delete?programId=s00000000000001",
      "/program/%2e%2e/create-link?programId=s00000000000001",
      "/program/create-link/extra?programId=s00000000000001",
    ]) {
      expect(pickCreateLinkPath(row("s00000000000001", [href])), href).toBeUndefined();
    }
  });

  it("is undefined when the row has no ad-link page", () => {
    expect(pickCreateLinkPath(row("s00000000000001", ["/program/detail-partnered?programId=s00000000000001"]))).toBeUndefined();
  });
});
