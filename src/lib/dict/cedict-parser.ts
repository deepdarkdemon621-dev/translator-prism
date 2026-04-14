import type { ParsedDictEntry } from "./types";

/**
 * CC-CEDICT line format:
 *   traditional simplified [pin1 yin1] /gloss 1/gloss 2/
 * Lines starting with `#` are comments and ignored.
 *
 * We emit one entry per line where headword is the *simplified* form (more
 * common in modern text). If you want to look up a traditional character,
 * we also emit a second entry keyed by the traditional form when it differs.
 */
const LINE_REGEX = /^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+\/(.+)\/\s*$/;

export function parseCedictLine(line: string): ParsedDictEntry[] {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return [];

  const match = LINE_REGEX.exec(trimmed);
  if (!match) return [];

  const [, traditional, simplified, pinyin, glossBlob] = match;
  // Gloss delimiter in CC-CEDICT is `/`. Collapse into " / " for display.
  const gloss = glossBlob.split("/").map((g) => g.trim()).filter(Boolean).join(" / ");
  const reading = pinyin.trim();

  const entries: ParsedDictEntry[] = [{ headword: simplified, reading, gloss }];
  if (traditional !== simplified) {
    entries.push({ headword: traditional, reading, gloss });
  }
  return entries;
}

/**
 * Stream a CC-CEDICT text blob line-by-line. Caller is responsible for
 * batching inserts — this yields per line.
 */
export function* parseCedict(text: string): Generator<ParsedDictEntry> {
  // CC-CEDICT files use \n line endings; guard against \r\n just in case.
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    for (const entry of parseCedictLine(line)) {
      yield entry;
    }
  }
}
