import type { APIRoute, GetStaticPaths } from "astro";

type GoRegistry = { offers: Record<string, string> };

const registry = (await import("../../../../../content/go-offers.json").catch(() => null)) as {
  default?: GoRegistry;
} | null;

/**
 * Affiliate redirects, one prerendered endpoint per APPROVED offer registered
 * in content/go-offers.json. The tracking URL never lives in articles or
 * logs (docs/05). Offers not registered here 404 — unapproved offers cannot
 * leak monetized links.
 */
export const getStaticPaths: GetStaticPaths = async () => {
  const offers = registry?.default?.offers ?? {};
  return Object.keys(offers).map((offerId) => ({ params: { offerId } }));
};

export const GET: APIRoute = async ({ params }) => {
  const offerId = params.offerId;
  const url = offerId ? registry?.default?.offers?.[offerId] : undefined;
  if (!url) {
    return new Response("offer not available", { status: 404 });
  }
  return new Response(null, {
    status: 302,
    headers: { Location: url, "cache-control": "no-store" },
  });
};
