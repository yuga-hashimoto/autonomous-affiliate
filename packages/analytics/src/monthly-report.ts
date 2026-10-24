import type { Conversion, Payout, SpendRecord } from "@aff/domain";
import { operatingProfitEstimateJpy } from "./kpi.js";

export interface MonthlyReport {
  yearMonth: string;
  confirmed: {
    approvedRevenueJpy: number;
    paidOutJpy: number;
    pendingJpy: number;
    rejectedJpy: number;
  };
  costs: {
    llmJpy: number;
    apiJpy: number;
    infraJpy: number;
    otherJpy: number;
    totalJpy: number;
    /** Costs partly estimated (no invoice yet). Never mixed into confirmed profit. */
    containsEstimates: boolean;
  };
  /** estimated: approved - costs. Clearly labelled as an estimate. */
  operatingProfitEstimateJpy: number;
  cashFlowJpy: number | "UNKNOWN";
  warnings: string[];
}

/**
 * B020: monthly business report. Confirmed (approved) vs pending vs paid are
 * reported separately; pending is never presented as revenue (docs/05).
 */
export function buildMonthlyReport(input: {
  yearMonth: string;
  conversions: Conversion[];
  payouts: Payout[];
  spend: SpendRecord[];
}): MonthlyReport {
  const inMonth = (iso: string) => iso.slice(0, 7) === input.yearMonth;
  const conversions = input.conversions.filter((c) => inMonth(c.occurredAt));
  const payouts = input.payouts.filter((p) => inMonth(p.paidAt));
  const spend = input.spend.filter((s) => s.date.startsWith(input.yearMonth));

  const sumBy = (statuses: Conversion["status"][]) =>
    conversions
      .filter((c) => statuses.includes(c.status))
      .reduce((acc, c) => acc + (c.amountJpy ?? c.amount ?? 0), 0);

  const approvedRevenueJpy = sumBy(["APPROVED"]);
  const pendingJpy = sumBy(["PENDING"]);
  const rejectedJpy = sumBy(["REJECTED", "CANCELED"]);
  const paidOutJpy = payouts.reduce((acc, p) => acc + (p.amountJpy ?? p.amount ?? 0), 0);

  const costs = {
    llmJpy: spend.filter((s) => s.category === "llm").reduce((a, s) => a + s.costJpy, 0),
    apiJpy: spend.filter((s) => s.category === "api").reduce((a, s) => a + s.costJpy, 0),
    infraJpy: spend.filter((s) => s.category === "infra").reduce((a, s) => a + s.costJpy, 0),
    otherJpy: spend.filter((s) => s.category === "other").reduce((a, s) => a + s.costJpy, 0),
    totalJpy: spend.reduce((a, s) => a + s.costJpy, 0),
    containsEstimates: spend.some((s) => s.estimated),
  };

  const profit = operatingProfitEstimateJpy({ conversions, payouts, spend });

  const warnings: string[] = [];
  if (pendingJpy > 0) {
    warnings.push(`pending conversions total ${pendingJpy} JPY and are NOT counted as revenue`);
  }
  if (costs.containsEstimates) {
    warnings.push("cost figures include estimates (no final invoice yet)");
  }
  if (payouts.length === 0) {
    warnings.push("no payouts recorded this month; cash flow is UNKNOWN");
  }

  return {
    yearMonth: input.yearMonth,
    confirmed: { approvedRevenueJpy, paidOutJpy, pendingJpy, rejectedJpy },
    costs,
    operatingProfitEstimateJpy: profit.operatingProfitJpy,
    cashFlowJpy: profit.cashFlowJpy,
    warnings,
  };
}

export function renderMonthlyReportMarkdown(report: MonthlyReport): string {
  const lines: string[] = [];
  lines.push(`# Monthly business report — ${report.yearMonth}`);
  lines.push("");
  lines.push("## Confirmed figures");
  lines.push(`- Approved revenue: ${report.confirmed.approvedRevenueJpy.toLocaleString("ja-JP")} JPY`);
  lines.push(`- Paid out: ${report.confirmed.paidOutJpy.toLocaleString("ja-JP")} JPY`);
  lines.push(`- Pending (NOT revenue): ${report.confirmed.pendingJpy.toLocaleString("ja-JP")} JPY`);
  lines.push(`- Rejected/canceled: ${report.confirmed.rejectedJpy.toLocaleString("ja-JP")} JPY`);
  lines.push("");
  lines.push("## Costs");
  lines.push(`- LLM: ${report.costs.llmJpy.toLocaleString("ja-JP")} JPY`);
  lines.push(`- API: ${report.costs.apiJpy.toLocaleString("ja-JP")} JPY`);
  lines.push(`- Infra: ${report.costs.infraJpy.toLocaleString("ja-JP")} JPY`);
  lines.push(`- Other: ${report.costs.otherJpy.toLocaleString("ja-JP")} JPY`);
  lines.push(`- Total: ${report.costs.totalJpy.toLocaleString("ja-JP")} JPY`);
  lines.push("");
  lines.push("## Estimates (not confirmed)");
  lines.push(`- Operating profit (approved - costs): ${report.operatingProfitEstimateJpy.toLocaleString("ja-JP")} JPY`);
  lines.push(`- Cash flow: ${report.cashFlowJpy === "UNKNOWN" ? "UNKNOWN" : `${report.cashFlowJpy.toLocaleString("ja-JP")} JPY`}`);
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}
