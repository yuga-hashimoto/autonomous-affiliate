import { randomUUID, createHash } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function newTraceId(): string {
  return randomUUID();
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Day key (YYYY-MM-DD) in a given IANA timezone, defaults to Asia/Tokyo. */
export function dayKeyInTz(date: Date, timeZone = "Asia/Tokyo"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return parts;
}

export function isFresh(fetchedAtIso: string, now: Date, maxAgeDays: number): boolean {
  const fetchedAt = Date.parse(fetchedAtIso);
  if (Number.isNaN(fetchedAt)) return false;
  const ageMs = now.getTime() - fetchedAt;
  return ageMs >= 0 && ageMs <= maxAgeDays * 24 * 60 * 60 * 1000;
}
