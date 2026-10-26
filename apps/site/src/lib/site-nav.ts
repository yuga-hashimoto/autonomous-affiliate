export interface NavItem {
  href: string;
  label: string;
}

/** Primary navigation (header). Kept to four items so the phone menu stays one screen. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/articles/", label: "記事一覧" },
  { href: "/methodology/", label: "比較方法" },
  { href: "/editorial-policy/", label: "編集方針" },
  { href: "/about/", label: "このサイトについて" },
];

export const FOOTER_ITEMS: readonly NavItem[] = [
  { href: "/", label: "ホーム" },
  ...NAV_ITEMS,
  { href: "/privacy/", label: "プライバシー" },
];

/** True when `path` is the item's page or lives beneath it (article pages highlight 記事一覧). */
export function isCurrent(href: string, path: string): boolean {
  return href === "/" ? path === "/" : path === href || path.startsWith(href);
}
