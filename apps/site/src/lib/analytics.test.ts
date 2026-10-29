import { describe, expect, it } from "vitest";
import {
  CTA_CHANNEL,
  CTA_EVENT_NAME,
  ctaClickEvent,
  ga4Snippet,
  measurementIdFrom,
  pageIdOf,
} from "./analytics";

describe("measurementIdFrom", () => {
  it("accepts a GA4 measurement id and trims surrounding whitespace", () => {
    expect(measurementIdFrom("G-ABC123DEF4")).toBe("G-ABC123DEF4");
    expect(measurementIdFrom("  G-ABC123DEF4\n")).toBe("G-ABC123DEF4");
  });

  it("treats anything else as not configured, so nothing is injected into the page", () => {
    for (const raw of [
      undefined,
      "",
      "   ",
      "G-",
      "UA-12345-1",
      "g-abc123def4",
      "G-ABC 123",
      "G-ABC123DEF4G-ABC123DEF5",
      `G-ABC123DEF4");alert(1);//`,
      `G-ABC123DEF4</script><script>alert(1)</script>`,
    ]) {
      expect(measurementIdFrom(raw), String(raw)).toBeUndefined();
    }
  });
});

describe("ga4Snippet", () => {
  const snippet = ga4Snippet("G-ABC123DEF4");

  it("loads gtag.js for the configured id only", () => {
    expect(snippet).toContain("https://www.googletagmanager.com/gtag/js?id=");
    expect(snippet).toContain("G-ABC123DEF4");
  });

  it("does not talk to any host other than googletagmanager", () => {
    const hosts = [...snippet.matchAll(/https?:\/\/([^/'"?\s]+)/g)].map((m) => m[1]);
    expect(new Set(hosts)).toEqual(new Set(["www.googletagmanager.com"]));
  });

  it("keeps the advertising features off", () => {
    expect(snippet).toContain("allow_google_signals:false");
    expect(snippet).toContain("allow_ad_personalization_signals:false");
  });

  it("stays silent for visitors who send Do Not Track or Global Privacy Control", () => {
    expect(snippet).toContain("doNotTrack");
    expect(snippet).toContain("globalPrivacyControl");
    // the loader is created only after that check, so no request is made for them
    expect(snippet.indexOf("globalPrivacyControl")).toBeLessThan(snippet.indexOf("createElement"));
  });
});

describe("pageIdOf", () => {
  it("uses the article slug for article pages, with or without a trailing slash", () => {
    expect(pageIdOf("/articles/sim-20gb/")).toBe("sim-20gb");
    expect(pageIdOf("/articles/sim-20gb")).toBe("sim-20gb");
  });

  it("falls back to a readable path for other pages", () => {
    expect(pageIdOf("/")).toBe("home");
    expect(pageIdOf("/about/")).toBe("about");
    expect(pageIdOf("/articles/")).toBe("articles");
  });
});

describe("ctaClickEvent", () => {
  it("describes a click on an affiliate redirect link with the docs/08 parameters", () => {
    expect(ctaClickEvent({ href: "/go/offer-sim-a", pathname: "/articles/e2e-sim/", ordinal: 2 })).toEqual({
      name: CTA_EVENT_NAME,
      params: { page_id: "e2e-sim", offer_id: "offer-sim-a", cta_id: "cta-2", channel: CTA_CHANNEL },
    });
    expect(CTA_EVENT_NAME).toBe("affiliate_cta_click");
  });

  it("ignores a trailing slash, query string and fragment on the redirect link", () => {
    for (const href of ["/go/offer-sim-a/", "/go/offer-sim-a?utm=x", "/go/offer-sim-a#top"]) {
      expect(ctaClickEvent({ href, pathname: "/articles/a/", ordinal: 1 })?.params.offer_id, href).toBe("offer-sim-a");
    }
  });

  it("never reports the destination URL or any query string", () => {
    const event = ctaClickEvent({ href: "/go/offer-sim-a?token=secret", pathname: "/articles/a/", ordinal: 1 });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toContain("http");
  });

  it("returns nothing for links that are not same-site affiliate redirects", () => {
    for (const href of [
      "",
      "/go/",
      "/go",
      "/about/",
      "/go/../admin",
      "/go/a/b",
      "//evil.example/go/offer",
      "https://example.com/go/offer-sim-a",
      "https://sim-a.example.com/price",
      "javascript:alert(1)",
    ]) {
      expect(ctaClickEvent({ href, pathname: "/articles/a/", ordinal: 1 }), href).toBeUndefined();
    }
  });
});
