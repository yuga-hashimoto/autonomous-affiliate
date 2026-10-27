/** Minimal hast node shape used by the chart renderer and its tests. */
export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export type ChartSpec =
  | { type: "key-figures"; items: { label: string; value: string }[] }
  | { type: "bars"; title: string; rows: { label: string; detail?: string; value: number | "UNKNOWN" }[] }
  | { type: "term-timeline"; title: string; comparisonMonths: number; minimumTermMonths: number };

/** Validates a ```chart block's JSON; throws an Error naming the chart when it cannot be drawn faithfully. */
export function parseChartBlock(source: string): ChartSpec;
export function renderChart(spec: ChartSpec): HastNode;
export function remarkCharts(): (tree: HastNode) => void;
