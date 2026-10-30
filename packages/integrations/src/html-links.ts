/**
 * The links of a fetched page. Pages are untrusted data: the address is resolved against the page
 * and only http(s) is kept; what a caller does with a link (fetch it, follow it) is decided by the
 * caller's own rules, never by the page's wording.
 */

export interface PageLink {
  url: string;
  text: string;
}

const MAX_LINKS = 500;
const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const IMG_ALT = /<img\b[^>]*\balt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const textOf = (inner: string): string =>
  decode(
    inner
      .replace(IMG_ALT, (_whole, double?: string, single?: string) => ` ${double ?? single ?? ""} `)
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();

/** Every http(s) link of a page, once each, with the text that shows for it. */
export function linksOfHtml(html: string, baseUrl: string): PageLink[] {
  const seen = new Set<string>();
  const links: PageLink[] = [];
  for (const match of html.matchAll(ANCHOR)) {
    const raw = HREF.exec(match[1] ?? "");
    const href = decode((raw?.[1] ?? raw?.[2] ?? raw?.[3] ?? "").trim());
    if (!href || href.startsWith("#")) continue;
    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    url.hash = "";
    const key = url.href;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ url: key, text: textOf(match[2] ?? "") });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}
