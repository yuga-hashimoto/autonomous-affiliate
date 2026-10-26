/** Minimal hast node shape used by the article transforms and their tests. */
export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

type Transformer = (tree: HastNode, file?: unknown) => void;

export function qualifyOutboundLinks(): Transformer;
export function dedupeLeadingMeta(): Transformer;
export function joinCjkLineBreaks(): Transformer;
export function enhanceTables(): Transformer;
export function markCallToAction(): Transformer;
export function markSourceList(): Transformer;
export const articleRehypePlugins: Array<() => Transformer>;
