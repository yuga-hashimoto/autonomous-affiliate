import { describe, expect, it } from "vitest";
import { siteVerificationFrom } from "./search-console";

describe("siteVerificationFrom", () => {
  it("accepts a Search Console HTML-tag token and trims surrounding whitespace", () => {
    const token = "UJjkdlGQFM-jwLHOohXyYrqVv1Z2LiYx4KK2dZDV4lo";
    expect(siteVerificationFrom(token)).toBe(token);
    expect(siteVerificationFrom(`  ${token}\n`)).toBe(token);
  });

  it("treats anything else as not configured, so no meta tag is written", () => {
    for (const raw of [
      undefined,
      "",
      "   ",
      "short",
      "UJjkdlGQFM-jwLHOohXyYrqVv1Z2LiYx4KK2dZDV4lo extra",
      `UJjkdlGQFM-jwLHOohXyYrqVv1Z2LiYx4KK2dZDV4lo"><script>alert(1)</script>`,
      `<meta name="google-site-verification" content="UJjkdlGQFM-jwLHOohXyYrqVv1Z2LiYx4KK2dZDV4lo">`,
      "a".repeat(101),
    ]) {
      expect(siteVerificationFrom(raw), String(raw)).toBeUndefined();
    }
  });
});
