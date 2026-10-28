import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approvedForExport, encryptForOwner, type ExportRow } from "../../apps/worker/src/a8-export.js";
import type { RawProgramRow } from "../../apps/worker/src/a8-programs.js";

const KEYS = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

interface Envelope {
  v: number;
  k: string;
  iv: string;
  tag: string;
  ct: string;
}

/** The owner's side, as the local decryption script does it. */
function decrypt(blob: string, privateKeyPem: string): string {
  const envelope = JSON.parse(Buffer.from(blob, "base64").toString("utf8")) as Envelope;
  const key = privateDecrypt(
    { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(envelope.k, "base64"),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]).toString("utf8");
}

describe("encryptForOwner", () => {
  const rows: ExportRow[] = [{ programId: "s00000001111111", name: "秘密のプログラム名", text: "成果報酬 9,999円" }];

  it("can be read back with the private key and nowhere else", () => {
    const blob = encryptForOwner(JSON.stringify(rows), KEYS.publicKey);
    expect(JSON.parse(decrypt(blob, KEYS.privateKey))).toEqual(rows);
  });

  it("leaves nothing readable in the output, in any encoding it is printed in", () => {
    const blob = encryptForOwner(JSON.stringify(rows), KEYS.publicKey);
    const decoded = Buffer.from(blob, "base64").toString("utf8");
    for (const secret of ["秘密のプログラム名", "s00000001111111", "9,999", "programId", "name"]) {
      expect(blob).not.toContain(secret);
      expect(decoded).not.toContain(secret);
    }
    expect(blob).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("is different every time, so equal inputs cannot be recognised", () => {
    expect(encryptForOwner("same", KEYS.publicKey)).not.toBe(encryptForOwner("same", KEYS.publicKey));
  });

  it("does not decrypt with another private key", () => {
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const blob = encryptForOwner("secret", KEYS.publicKey);
    expect(() => decrypt(blob, other.privateKey)).toThrow();
  });

  it("refuses a missing, malformed or too small key rather than printing in the clear", () => {
    expect(() => encryptForOwner("x", "")).toThrow(/public key/i);
    expect(() => encryptForOwner("x", "not a pem")).toThrow(/public key/i);
    const small = generateKeyPairSync("rsa", { modulusLength: 1024, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    expect(() => encryptForOwner("x", small.publicKey)).toThrow(/2048/);
  });

  it("refuses a private key given by mistake", () => {
    expect(() => encryptForOwner("x", KEYS.privateKey)).toThrow(/public key/i);
  });
});

describe("approvedForExport", () => {
  const link = (id: string): string[] => [`/program/create-link?programId=${id}`];
  const rows: RawProgramRow[] = [
    { programId: "s0000001", name: "A", text: "A 成果報酬", hrefs: link("s0000001") },
    { programId: "s0000002", name: "B", text: "B プログラム終了", hrefs: link("s0000002") },
    { programId: "s0000003", name: "C", text: "C", hrefs: [] },
    { programId: "s0000004", text: "D の説明", hrefs: link("s0000004") },
  ];

  it("keeps only approved programs with their id, name and card text", () => {
    expect(approvedForExport(rows)).toEqual([
      { programId: "s0000001", name: "A", text: "A 成果報酬" },
      { programId: "s0000004", name: "D の説明", text: "D の説明" },
    ]);
  });
});
