import type { APIRoute, GetStaticPaths } from "astro";

type GoRegistry = { offers: Record<string, string> };

async function loadRegistry(): Promise<GoRegistry> {
  // Priority 1: build-time secret (CI). Tracking URLs must NOT be committed to
  // git (docs/05). Set AFFILIATE_TRACKING_URLS_JSON='{"offers":{"<offer_id>":"<url>"}}'.
  const fromEnv = process.env.AFFILIATE_TRACKING_URLS_JSON;
  if (fromEnv) {
    try {
      const parsed = JSON.parse(fromEnv) as GoRegistry;
      if (parsed && typeof parsed === "object" && parsed.offers) return parsed;
    } catch {
      throw new Error("AFFILIATE_TRACKING_URLS_JSON is not valid JSON");
    }
  }
  // Priority 2: files in content/. go-offers.json is the tracked placeholder (empty in the
  // repository); go-offers.generated.json is written by `export-go-offers` from the database just
  // before a build and is never committed (docs/20). A glob, so a missing file is not an error.
  const files = import.meta.glob<GoRegistry>("../../../../../content/go-offers*.json", {
    eager: true,
    import: "default",
  });
  const offers: Record<string, string> = {};
  for (const registry of Object.values(files)) Object.assign(offers, registry?.offers ?? {});
  return { offers };
}

/**
 * Affiliate redirects, one prerendered endpoint per APPROVED offer. The
 * tracking URL comes from build-time secrets only; unregistered offers 404 —
 * unapproved offers cannot leak monetized links.
 */
export const getStaticPaths: GetStaticPaths = async () => {
  const offers = (await loadRegistry()).offers;
  return Object.keys(offers).map((offerId) => ({ params: { offerId } }));
};

export const GET: APIRoute = async ({ params }) => {
  const offerId = params.offerId;
  const url = offerId ? (await loadRegistry()).offers[offerId] : undefined;
  if (!url) {
    return new Response("offer not available", { status: 404 });
  }
  return new Response(null, {
    status: 302,
    headers: { Location: url, "cache-control": "no-store" },
  });
};
