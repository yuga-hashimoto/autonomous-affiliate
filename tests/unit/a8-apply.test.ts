import { describe, expect, it } from "vitest";
import {
  chooseSiteOption,
  hiddenSiteState,
  isApplyFormAction,
  isNotPartneredDetail,
  type ApplySiteOption,
} from "../../apps/worker/src/a8-apply.js";

const option = (value: string, text: string, selected = false): ApplySiteOption => ({ value, text, selected });

describe("chooseSiteOption", () => {
  it("picks the one option that names the target site", () => {
    const options = [option("111", "最初のサイト", true), option("222", "総額比較 (example.test)")];
    expect(chooseSiteOption(options, "総額比較")).toEqual({ value: "222" });
  });

  it("does not guess when the target is missing", () => {
    expect(chooseSiteOption([option("111", "最初のサイト", true), option("222", "別のサイト")], "総額比較")).toBeUndefined();
    expect(chooseSiteOption([], "総額比較")).toBeUndefined();
  });

  it("does not guess when two options could be the target", () => {
    const options = [option("111", "総額比較"), option("222", "総額比較 (旧)")];
    expect(chooseSiteOption(options, "総額比較")).toBeUndefined();
  });

  it("does not choose an option that has no value to submit", () => {
    expect(chooseSiteOption([option("", "総額比較")], "総額比較")).toBeUndefined();
  });

  it("does not match an empty target", () => {
    expect(chooseSiteOption([option("111", "何か")], "")).toBeUndefined();
  });
});

describe("isApplyFormAction", () => {
  it("accepts only the single-program application step", () => {
    expect(isApplyFormAction("/program/agreement/apply")).toBe(true);
    expect(isApplyFormAction("https://media-console.a8.net/program/agreement/apply")).toBe(true);
  });

  it("rejects the bulk application and any lookalike", () => {
    for (const action of [
      "/program/agreement/bulk-apply-confirm",
      "/program/agreement/apply/extra",
      "/program/agreement/apply-all",
      "/program/agreement/apply/../bulk-apply-confirm",
      "/program/agreement/%2e%2e/bulk-apply-confirm",
      "https://example.test/program/agreement/apply",
      "//example.test/program/agreement/apply",
      "",
      "#",
    ]) {
      expect(isApplyFormAction(action), action).toBe(false);
    }
  });
});

describe("isNotPartneredDetail", () => {
  it("is true only for a program the account has not joined yet", () => {
    expect(isNotPartneredDetail("/program/detail-not-partnered?programId=s00000000000001&fromSearch=1")).toBe(true);
    expect(isNotPartneredDetail("/program/detail-partnered?programId=s00000000000001")).toBe(false);
    expect(isNotPartneredDetail("/program/create-link?programId=s00000000000001")).toBe(false);
    expect(isNotPartneredDetail("https://example.test/program/detail-not-partnered?programId=x")).toBe(false);
  });
});

describe("hiddenSiteState", () => {
  it("tells whether the form's own copy of the site agrees with the choice", () => {
    expect(hiddenSiteState("", "222")).toBe("empty");
    expect(hiddenSiteState("222", "222")).toBe("same");
    expect(hiddenSiteState("111", "222")).toBe("different");
  });
});
