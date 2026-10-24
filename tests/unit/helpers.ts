import { readFileSync } from "node:fs";
import { parsePolicyText, type PolicyConfig } from "@aff/domain";

export function readFileSyncHelper(path: URL): string {
  return readFileSync(path, "utf8");
}

export { readFileSync, parsePolicyText };
export type { PolicyConfig };
