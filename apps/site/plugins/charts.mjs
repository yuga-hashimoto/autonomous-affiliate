// @ts-check
/**
 * Charts for pipeline-generated articles.
 *
 * The draft engine writes a fenced ```chart block holding JSON that the
 * calculators produced; this remark plugin turns it into a <figure> made of
 * plain HTML and CSS (no script, no image file). Every figure repeats its
 * numbers as text, so the bars are decoration and nothing is conveyed by
 * colour or length alone. A malformed block fails the build, which the live
 * publisher treats as "nothing is committed, the previous version stays live".
 */
import { visit } from "unist-util-visit";

/** @typedef {any} HastNode  hast nodes are plain objects; the typings are not a dependency. */

const UNKNOWN = "UNKNOWN";

/** @param {string} message @returns {never} */
function fail(message) {
  throw new Error(`chart block: ${message}`);
}

/** @param {unknown} value */
function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** @param {unknown} value */
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Validates one block's JSON. Throws (naming the chart) on anything the
 * renderer could not draw faithfully, instead of drawing something wrong.
 * @param {string} source
 */
export function parseChartBlock(source) {
  /** @type {any} */
  let data;
  try {
    data = JSON.parse(source);
  } catch {
    return fail("is not valid JSON");
  }
  if (data === null || typeof data !== "object") return fail("must be a JSON object");

  switch (data.type) {
    case "key-figures": {
      if (!Array.isArray(data.items) || data.items.length === 0) return fail("key-figures needs at least one item");
      for (const item of data.items) {
        if (!isText(item?.label) || !isText(item?.value)) return fail("every key-figures item needs a label and a value");
      }
      return {
        type: "key-figures",
        items: data.items.map((/** @type {any} */ item) => ({ label: item.label, value: item.value })),
      };
    }
    case "bars": {
      if (!isText(data.title)) return fail("bars needs a title");
      if (!Array.isArray(data.rows) || data.rows.length === 0) return fail("bars needs at least one row");
      for (const row of data.rows) {
        if (!isText(row?.label)) return fail("every bars row needs a label");
        const amount = row.value;
        const valid = amount === UNKNOWN || (typeof amount === "number" && Number.isFinite(amount) && amount >= 0);
        if (!valid) return fail(`a bars row value must be a non-negative number or ${UNKNOWN}`);
        if (row.detail !== undefined && !isText(row.detail)) return fail("a bars row detail must be text");
      }
      return {
        type: "bars",
        title: data.title,
        rows: data.rows.map((/** @type {any} */ row) => ({
          label: row.label,
          ...(row.detail === undefined ? {} : { detail: row.detail }),
          value: row.value,
        })),
      };
    }
    case "term-timeline": {
      if (!isText(data.title)) return fail("term-timeline needs a title");
      if (!isPositiveInteger(data.comparisonMonths) || !isPositiveInteger(data.minimumTermMonths)) {
        return fail("term-timeline needs whole, positive month counts");
      }
      return {
        type: "term-timeline",
        title: data.title,
        comparisonMonths: data.comparisonMonths,
        minimumTermMonths: data.minimumTermMonths,
      };
    }
    default:
      return fail(`unknown type ${JSON.stringify(data.type)}`);
  }
}

/** @param {string} tagName @param {Record<string, unknown>} properties @param {...HastNode} children @returns {HastNode} */
function el(tagName, properties, ...children) {
  return { type: "element", tagName, properties, children };
}

/** @param {string} value @returns {HastNode} */
function text(value) {
  return { type: "text", value };
}

/** @param {number} amount */
function yen(amount) {
  return `${amount.toLocaleString("ja-JP")}円`;
}

/** @param {number} value @param {number} max */
function widthStyle(value, max) {
  const percent = max > 0 ? (value / max) * 100 : 0;
  return `width:${percent.toFixed(1)}%`;
}

/**
 * One labelled row: the text carries the meaning, the bar is decoration.
 * @param {{ label: string, detail?: string, valueText: string, fill: number | null, max: number, extraClass?: string }} row
 * @returns {HastNode}
 */
function barRow({ label, detail, valueText, fill, max, extraClass }) {
  const unknown = fill === null;
  const classNames = ["chart-row", ...(unknown ? ["row-unknown"] : []), ...(extraClass ? [extraClass] : [])];
  return el(
    "li",
    { className: classNames },
    el("span", { className: ["chart-label"] }, text(label)),
    el("span", { className: ["chart-value"] }, text(valueText)),
    ...(detail ? [el("span", { className: ["chart-detail"] }, text(detail))] : []),
    el(
      "span",
      { className: ["chart-track"], ariaHidden: "true" },
      ...(unknown ? [] : [el("span", { className: ["chart-bar-fill"], style: widthStyle(/** @type {number} */ (fill), max) })]),
    ),
  );
}

/** @param {string} title @param {string[]} classNames @param {HastNode[]} rows @param {HastNode[]} [after] @returns {HastNode} */
function barsFigure(title, classNames, rows, after = []) {
  return el(
    "figure",
    { className: ["chart", "chart-bars", ...classNames] },
    el("figcaption", { className: ["chart-title"] }, text(title)),
    el("ul", { className: ["chart-rows"] }, ...rows),
    ...after,
  );
}

/** @param {ReturnType<typeof parseChartBlock>} spec @returns {HastNode} */
export function renderChart(spec) {
  if (spec.type === "key-figures") {
    return el(
      "figure",
      { className: ["chart", "chart-key-figures"] },
      el(
        "dl",
        {},
        ...spec.items.map((/** @type {{ label: string, value: string }} */ item) =>
          el(
            "div",
            { className: ["figure-item"] },
            el("dt", {}, text(item.label)),
            el("dd", { className: item.value === UNKNOWN ? ["figure-unknown"] : [] }, text(item.value)),
          ),
        ),
      ),
    );
  }

  if (spec.type === "bars") {
    const amounts = spec.rows.flatMap((/** @type {{ value: number | string }} */ row) => (typeof row.value === "number" ? [row.value] : []));
    const max = Math.max(0, ...amounts);
    return barsFigure(
      spec.title,
      [],
      spec.rows.map((/** @type {{ label: string, detail?: string, value: number | string }} */ row) =>
        barRow({
          label: row.label,
          detail: row.detail,
          valueText: typeof row.value === "number" ? yen(row.value) : UNKNOWN,
          fill: typeof row.value === "number" ? row.value : null,
          max,
        }),
      ),
    );
  }

  const max = Math.max(spec.comparisonMonths, spec.minimumTermMonths);
  const shorter = spec.comparisonMonths < spec.minimumTermMonths;
  return barsFigure(
    spec.title,
    ["chart-term"],
    [
      barRow({ label: "比較期間", valueText: `${spec.comparisonMonths}ヶ月`, fill: spec.comparisonMonths, max }),
      barRow({ label: "最低利用期間", valueText: `${spec.minimumTermMonths}ヶ月`, fill: spec.minimumTermMonths, max, extraClass: "row-term" }),
    ],
    shorter
      ? [
          el(
            "p",
            { className: ["chart-note"] },
            text(
              `比較期間（${spec.comparisonMonths}ヶ月）は最低利用期間（${spec.minimumTermMonths}ヶ月）より短いため、期間内に解約すると契約解除料が発生する場合があります。契約解除料は総額に含めていません。`,
            ),
          ),
        ]
      : [],
  );
}

/** Replaces every ```chart code block with its rendered figure. */
export function remarkCharts() {
  return (/** @type {HastNode} */ tree) => {
    visit(tree, "code", (/** @type {HastNode} */ node, /** @type {number | undefined} */ index, /** @type {HastNode | undefined} */ parent) => {
      if (node.lang !== "chart" || !parent || index === undefined) return;
      const figure = renderChart(parseChartBlock(String(node.value)));
      parent.children[index] = {
        type: "chart",
        data: { hName: figure.tagName, hProperties: figure.properties, hChildren: figure.children },
      };
    });
  };
}
