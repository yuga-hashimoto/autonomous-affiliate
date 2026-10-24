import { z } from "zod";
import type { OfferRepository } from "@aff/db";
import type { Conversion } from "@aff/domain";

const csvRowSchema = z.object({
  program_id: z.string().min(1),
  external_event_id: z.string().min(1).optional(),
  offer_id: z.string().min(1).optional(),
  occurred_at: z.string().min(1),
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELED", "PAID"]),
  amount: z.coerce.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
});

export type AspReportRow = Conversion;

export interface AspImportResult {
  imported: number;
  skipped: number;
  duplicates: number;
  skippedReasons: string[];
}

function parseCsv(csvText: string): Record<string, string>[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0]!.split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      const value = cells[i];
      if (value !== undefined && value !== "") row[h] = value;
    });
    return row;
  });
}

/**
 * B015: imports ASP conversion reports. PENDING/APPROVED/PAID stay distinct
 * (docs/05); rows for unknown programs are skipped, never guessed; the
 * repository enforces UNIQUE(program_id, external_event_id) idempotency.
 */
export class AspReportImporter {
  constructor(private readonly offers: OfferRepository, private readonly clock: () => Date = () => new Date()) {}

  async importCsv(csvText: string): Promise<AspImportResult> {
    const result: AspImportResult = { imported: 0, skipped: 0, duplicates: 0, skippedReasons: [] };
    for (const [index, raw] of parseCsv(csvText).entries()) {
      const parsed = csvRowSchema.safeParse(raw);
      if (!parsed.success) {
        result.skipped += 1;
        result.skippedReasons.push(`row ${index + 2}: invalid format`);
        continue;
      }
      const data = parsed.data;
      const program = await this.offers.getProgram(data.program_id);
      if (!program) {
        result.skipped += 1;
        result.skippedReasons.push(`row ${index + 2}: unknown program ${data.program_id}`);
        continue;
      }
      if (data.offer_id) {
        const offer = await this.offers.getOffer(data.offer_id);
        if (!offer) {
          result.skipped += 1;
          result.skippedReasons.push(`row ${index + 2}: unknown offer ${data.offer_id}`);
          continue;
        }
      }
      const conversion: AspReportRow = {
        id: `conv_${data.program_id}_${data.external_event_id ?? crypto.randomUUID()}`,
        programId: data.program_id,
        externalEventId: data.external_event_id,
        offerId: data.offer_id,
        occurredAt: new Date(data.occurred_at).toISOString(),
        status: data.status,
        amount: data.amount,
        currency: data.currency,
      };
      const { created } = await this.offers.importConversion(conversion);
      if (created) result.imported += 1;
      else result.duplicates += 1;
    }
    return result;
  }
}

/** Approved-only view used by monetizable CTA selection (docs/14). */
export function splitBySettlement(conversions: Conversion[]): {
  pendingJpy: number;
  approvedJpy: number;
  rejectedJpy: number;
  paidJpy: number;
} {
  let pendingJpy = 0;
  let approvedJpy = 0;
  let rejectedJpy = 0;
  let paidJpy = 0;
  for (const c of conversions) {
    const amount = c.amountJpy ?? c.amount ?? 0;
    switch (c.status) {
      case "PENDING":
        pendingJpy += amount;
        break;
      case "APPROVED":
        approvedJpy += amount;
        break;
      case "REJECTED":
      case "CANCELED":
        rejectedJpy += amount;
        break;
      case "PAID":
        paidJpy += amount;
        break;
    }
  }
  return { pendingJpy, approvedJpy, rejectedJpy, paidJpy };
}
