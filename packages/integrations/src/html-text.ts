/**
 * Turns a fetched page into the text a person would read, and picks the parts
 * of it worth sending to fact extraction. Raw HTML starts with <head>, scripts
 * and navigation, so cutting it at a fixed length (as the extractor used to)
 * misses the price table on real sites.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  yen: "¥",
  copy: "©",
  reg: "®",
  hellip: "…",
  middot: "·",
  ndash: "–",
  mdash: "—",
  times: "×",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

const BLOCK_TAGS =
  "p|div|br|li|ul|ol|dl|dt|dd|tr|table|thead|tbody|tfoot|section|article|header|footer|nav|main|aside|h[1-6]|form|fieldset|figure|figcaption|blockquote|hr|pre|details|summary";

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Visible text of an HTML page: scripts, styles, comments and the head are
 * dropped (the title is kept), block elements become line breaks and the cells
 * of a table row stay on one line separated by " | ". Non-HTML content (JSON,
 * plain text) is returned trimmed and otherwise untouched.
 */
export function htmlToVisibleText(body: string, contentType = "text/html"): string {
  if (!/html/i.test(contentType)) return body.trim();

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? "";
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, " | ")
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<[^>]*>/g, "");

  const lines = decodeEntities(`${title}\n${stripped}`)
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0\u3000]+/g, " ").trim())
    .filter((line) => line !== "");

  // Menus repeat the same line many times in a row; keep one copy.
  return lines.filter((line, index) => index === 0 || line !== lines[index - 1]).join("\n");
}

/** Terms that mark price, contract and fee statements; used to rank text windows. */
export const PRICE_KEYWORDS: readonly string[] = [
  "円",
  "¥",
  "￥",
  "税込",
  "税抜",
  "月額",
  "料金",
  "送料",
  "手数料",
  "解約",
  "解除",
  "最低",
  "契約",
  "無料",
  "返送",
  "査定",
  "水代",
  "電気代",
  "設置",
  "プラン",
];

export interface TextWindowOptions {
  /** Maximum characters per window (one model call each). */
  windowChars?: number;
  /** Maximum number of windows returned. */
  maxWindows?: number;
  keywords?: readonly string[];
}

interface LineWindow {
  text: string;
  startLine: number;
  endLine: number;
  score: number;
}

const DEFAULT_WINDOW_CHARS = 6000;
const DEFAULT_MAX_WINDOWS = 3;
const KEYWORD_COUNT_CAP = 10;
/** A later window is skipped when more than this share of its lines is already covered. */
const MAX_OVERLAP_RATIO = 0.5;

function splitLongLine(line: string, limit: number): string[] {
  if (line.length <= limit) return [line];
  const pieces: string[] = [];
  for (let offset = 0; offset < line.length; offset += limit) pieces.push(line.slice(offset, offset + limit));
  return pieces;
}

function scoreText(text: string, keywords: readonly string[]): number {
  return keywords.reduce((sum, keyword) => sum + Math.min(text.split(keyword).length - 1, KEYWORD_COUNT_CAP), 0);
}

/** Half-overlapping windows over whole lines, so a block shorter than half a window is never split. */
function buildWindows(lines: string[], windowChars: number, keywords: readonly string[]): LineWindow[] {
  const windows: LineWindow[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && size + lines[end]!.length + 1 <= windowChars) {
      size += lines[end]!.length + 1;
      end += 1;
    }
    if (end === start) end = start + 1;
    const text = lines.slice(start, end).join("\n");
    windows.push({ text, startLine: start, endLine: end, score: scoreText(text, keywords) });
    if (end >= lines.length) break;

    let next = start;
    let moved = 0;
    while (next < end && moved < windowChars / 2) {
      moved += lines[next]!.length + 1;
      next += 1;
    }
    start = Math.max(next, start + 1);
  }
  return windows;
}

function overlapRatio(candidate: LineWindow, chosen: readonly LineWindow[]): number {
  const covered = chosen.reduce(
    (sum, other) => sum + Math.max(0, Math.min(candidate.endLine, other.endLine) - Math.max(candidate.startLine, other.startLine)),
    0,
  );
  return covered / (candidate.endLine - candidate.startLine);
}

/**
 * The most price-relevant parts of `text`, at most `maxWindows` windows of at
 * most `windowChars` characters, in document order. Windows without any price
 * or contract term are not returned (they would only cost model calls); when
 * nothing matches, the first window is returned so the caller still sees the page.
 */
export function selectRelevantWindows(text: string, options: TextWindowOptions = {}): string[] {
  const windowChars = options.windowChars ?? DEFAULT_WINDOW_CHARS;
  const maxWindows = options.maxWindows ?? DEFAULT_MAX_WINDOWS;
  const keywords = options.keywords ?? PRICE_KEYWORDS;

  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (trimmed.length <= windowChars) return [trimmed];

  const lines = trimmed.split("\n").flatMap((line) => splitLongLine(line, windowChars));
  const windows = buildWindows(lines, windowChars, keywords);
  const ranked = [...windows].sort((a, b) => b.score - a.score || a.startLine - b.startLine);
  if (ranked[0]!.score === 0) return [windows[0]!.text];

  const chosen: LineWindow[] = [];
  for (const candidate of ranked) {
    if (chosen.length >= maxWindows || candidate.score === 0) break;
    if (overlapRatio(candidate, chosen) > MAX_OVERLAP_RATIO) continue;
    chosen.push(candidate);
  }
  return chosen.sort((a, b) => a.startLine - b.startLine).map((window) => window.text);
}
