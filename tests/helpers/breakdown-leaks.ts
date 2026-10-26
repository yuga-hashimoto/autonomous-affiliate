const JAPANESE = /[぀-ヿ㐀-鿿]/;
const ENGLISH_WORD = /[A-Za-z]{3,}/;
// The formula is an identifier-based expression and the version is an id, so
// both stay ASCII by design; only labels and assumptions are reader prose.
const CODE_LINE = /^- (計算式|式バージョン):/;
const AMOUNT_SUFFIX = /: (?:-?[\d,]+円|UNKNOWN)$/;

/** The 試算の内訳 section: from its heading up to the next `## ` heading. */
export function extractBreakdownSection(markdown: string): string {
  const start = markdown.indexOf("## 試算の内訳");
  if (start === -1) throw new Error("試算の内訳 section not found");
  const next = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, next === -1 ? undefined : next);
}

/**
 * Bullet lines of the 試算の内訳 section whose label/assumption text is not
 * Japanese prose (ASCII-only, or containing English words). `UNKNOWN` is the
 * project-wide literal and unit tokens like GB/L are 1-2 letters, so neither
 * counts as a leak.
 */
export function findNonJapaneseBreakdownLines(markdown: string): string[] {
  return extractBreakdownSection(markdown)
    .split("\n")
    .filter((line) => line.startsWith("- ") && !CODE_LINE.test(line))
    .filter((line) => {
      const text = line
        .slice(2)
        .replace(/^前提: /, "")
        .replace(AMOUNT_SUFFIX, "")
        .replaceAll("UNKNOWN", "");
      return !JAPANESE.test(text) || ENGLISH_WORD.test(text);
    });
}
