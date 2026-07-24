import { createHash } from "crypto";

/**
 * SHA-256 over the UTF-8 bytes of the paragraph source text. Used to bind a
 * translation attempt to the exact source it was generated from; a canonical
 * write must never activate when the stored hash no longer matches.
 */
export function sourceHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
