import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { brandOfOfferId, type A8Brand } from "@aff/agents";

/**
 * The pages that carry an ad (docs/20): the built article pages that link to `/go/<offer>`, each
 * with the URL the site itself names for it (its canonical link), grouped by the brand of the
 * offers it links to. These are the URLs registered with the advertiser's program in the A8
 * console (広告掲載URL管理), so only the pages that really carry the ad are ever listed.
 */

const GO_LINK = /href="\/go\/([^"]*)"/g;
const OFFER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CANONICAL = /<link[^>]*\brel="canonical"[^>]*\bhref="([^"]+)"|<link[^>]*\bhref="([^"]+)"[^>]*\brel="canonical"/;

/** The page's canonical URL and the offers it links to; undefined when it has no ad or no usable URL. */
export function adPagesFromHtml(html: string): { url: string; offerIds: string[] } | undefined {
  const offerIds = [...new Set([...html.matchAll(GO_LINK)].map((match) => match[1] ?? "").filter((id) => OFFER_ID.test(id)))];
  if (offerIds.length === 0) return undefined;
  const match = CANONICAL.exec(html);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? { url: url.href, offerIds } : undefined;
  } catch {
    return undefined;
  }
}

async function articlePages(distDir: string): Promise<string[]> {
  const root = join(distDir, "articles");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name, "index.html"));
}

/** Brand slug -> the sorted, unique URLs of the article pages that carry that brand's ad. */
export async function collectAdPages(distDir: string, brands: readonly A8Brand[]): Promise<Record<string, string[]>> {
  const byBrand = new Map<string, Set<string>>();
  for (const file of await articlePages(distDir)) {
    const html = await readFile(file, "utf8").catch(() => undefined);
    const found = html === undefined ? undefined : adPagesFromHtml(html);
    if (!found) continue;
    for (const offerId of found.offerIds) {
      const brand = brandOfOfferId(offerId, brands);
      if (brand) byBrand.set(brand.brandSlug, (byBrand.get(brand.brandSlug) ?? new Set()).add(found.url));
    }
  }
  return Object.fromEntries([...byBrand].map(([slug, urls]) => [slug, [...urls].sort()]));
}
