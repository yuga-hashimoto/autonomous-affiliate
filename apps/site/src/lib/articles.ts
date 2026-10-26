/**
 * Pure helpers shared by the home page, the paginated archive, the search
 * index and the article page. Kept free of `astro:*` imports so they can be
 * unit-tested with plain vitest.
 */

export const SITE_NAME = "総額比較";
/** Archive page size: small enough for a phone, large enough to keep page counts low. */
export const ARTICLES_PER_PAGE = 12;
const RELATED_DEFAULT_LIMIT = 3;
const CHARS_PER_MINUTE = 500;

export interface ArticleLike {
  id: string;
  data: {
    title: string;
    description: string;
    pubDate: string;
    offerIds: string[];
  };
}

export interface Page<T> {
  items: T[];
  page: number;
  totalPages: number;
  totalCount: number;
}

function timestamp(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

/** Newest first. Unparseable dates sort last; ties keep the input order. */
export function sortByNewest<T extends ArticleLike>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index, time: timestamp(entry.data.pubDate) }))
    .sort((a, b) => (a.time === b.time ? a.index - b.index : b.time > a.time ? 1 : -1))
    .map(({ entry }) => entry);
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/** `YYYY-MM-DD` prefix of an ISO timestamp (used for <time datetime>). */
export function isoDate(iso: string): string {
  const match = ISO_DAY.exec(iso);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : iso.slice(0, 10);
}

/** `2026年10月6日` from an ISO timestamp, without timezone drift. */
export function formatDate(iso: string): string {
  const match = ISO_DAY.exec(iso);
  if (!match) return iso.slice(0, 10);
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}

/** Rough reading time from the markdown body; markdown punctuation and whitespace are not counted. */
export function readingMinutes(markdownBody: string): number {
  const visible = markdownBody.replace(/[\s|#>*`\-[\]()]/g, "");
  return Math.max(1, Math.ceil(visible.length / CHARS_PER_MINUTE));
}

/**
 * Next-read suggestions: articles sharing an offer with the current one come
 * first (same topic), then the newest remaining articles.
 */
export function relatedArticles<T extends ArticleLike>(
  current: T,
  all: readonly T[],
  limit: number = RELATED_DEFAULT_LIMIT,
): T[] {
  const others = sortByNewest(all.filter((entry) => entry.id !== current.id));
  const shared = new Set(current.data.offerIds);
  const sameTopic = others.filter((entry) => entry.data.offerIds.some((id) => shared.has(id)));
  const rest = others.filter((entry) => !sameTopic.includes(entry));
  return [...sameTopic, ...rest].slice(0, limit);
}

export function paginate<T>(items: readonly T[], page: number, perPage: number): Page<T> {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), page, totalPages, totalCount: items.length };
}

/**
 * Page numbers to render in the pager: first, last and the current page's
 * neighbours. A single hidden page is printed instead of an ellipsis.
 */
export function pageWindow(current: number, total: number): (number | "…")[] {
  const wanted = new Set([1, total, current - 1, current, current + 1]);
  const pages = [...wanted].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const result: (number | "…")[] = [];
  pages.forEach((n, i) => {
    const previous = pages[i - 1];
    if (previous !== undefined) {
      const gap = n - previous;
      if (gap === 2) result.push(previous + 1);
      else if (gap > 2) result.push("…");
    }
    result.push(n);
  });
  return result;
}

export function archiveHref(page: number): string {
  return page <= 1 ? "/articles/" : `/articles/page/${page}/`;
}
