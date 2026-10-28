import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { withA8Session, type A8SmokeResult } from "./a8-login.js";
import { isProgramId, readListPage, statusInList, type RawProgramRow } from "./a8-programs.js";

/**
 * Hands the approved programs (id, name, card text) to the repository owner without publishing them.
 *
 * A8's program names and conditions are member-only and the repository and its Actions logs are public,
 * so the rows are encrypted for a public key before they are printed: RSA-OAEP wraps a one-time
 * AES-256-GCM key. Only the holder of the private key (kept off GitHub) can read the output.
 */

const MIN_MODULUS_BITS = 2048;
const MAX_PAGES = 10;

export interface ExportRow {
  programId: string;
  name: string;
  text: string;
}

/** The rows of the participating list that are approved and usable (an ad-link page exists). */
export function approvedForExport(rows: readonly RawProgramRow[]): ExportRow[] {
  const seen = new Set<string>();
  const exported: ExportRow[] = [];
  for (const row of rows) {
    if (!isProgramId(row.programId) || seen.has(row.programId)) continue;
    if (statusInList("partnered", row.text, row.hrefs) !== "approved") continue;
    seen.add(row.programId);
    exported.push({ programId: row.programId, name: row.name?.trim() || row.text, text: row.text });
  }
  return exported;
}

function publicKeyOf(pem: string) {
  if (!pem.trim() || /PRIVATE KEY/.test(pem)) throw new Error("A8_EXPORT_PUBLIC_KEY must be an RSA public key (PEM)");
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new Error("A8_EXPORT_PUBLIC_KEY is not a valid public key (PEM)");
  }
  if (key.asymmetricKeyType !== "rsa") throw new Error("the public key must be an RSA key");
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_MODULUS_BITS) {
    throw new Error(`the RSA public key must be at least ${MIN_MODULUS_BITS} bits`);
  }
  return key;
}

/** Encrypts `plaintext` for the owner of `publicKeyPem`. The result is one base64 line. */
export function encryptForOwner(plaintext: string, publicKeyPem: string): string {
  const publicKey = publicKeyOf(publicKeyPem);
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const wrappedKey = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    dataKey,
  );
  const envelope = {
    v: 1,
    k: wrappedKey.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ciphertext.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

async function readPartneredRows(page: Page): Promise<RawProgramRow[]> {
  const rows = new Map<string, RawProgramRow>();
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
    const before = rows.size;
    for (const row of (await readListPage(page, "partnered", pageNo)).rows) {
      if (!rows.has(row.programId)) rows.set(row.programId, row);
    }
    if (rows.size === before) break;
  }
  return Array.from(rows.values());
}

export interface ExportReport {
  outcome: "ok" | "login_failed";
  login?: A8SmokeResult;
  count?: number;
  /** base64; decrypt with the private key. */
  encrypted?: string;
}

/** Logs in, reads the approved programs and returns them encrypted. Changes nothing in the console. */
export async function runA8ExportApproved(env: NodeJS.ProcessEnv): Promise<ExportReport> {
  const publicKeyPem = env.A8_EXPORT_PUBLIC_KEY ?? "";
  encryptForOwner("check", publicKeyPem); // fail before logging in if the key is unusable
  const { login, value } = await withA8Session(env, readPartneredRows);
  if (!value) return { outcome: "login_failed", login };
  const approved = approvedForExport(value);
  return { outcome: "ok", count: approved.length, encrypted: encryptForOwner(JSON.stringify(approved), publicKeyPem) };
}
