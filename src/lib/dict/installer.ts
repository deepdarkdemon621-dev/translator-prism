import { randomUUID } from "crypto";
import { getDb, getSqlite } from "@/lib/db";
import { dictionaries } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { parseCedict } from "./cedict-parser";
import { parseJMdict } from "./jmdict-parser";
import type { DictFormat, DictSourceLang, DictTargetLang, ParsedDictEntry } from "./types";

export interface InstallResult {
  id: string;
  name: string;
  format: DictFormat;
  sourceLang: DictSourceLang;
  targetLang: DictTargetLang;
  entryCount: number;
}

function entriesFor(
  format: DictFormat,
  text: string,
  targetLang: DictTargetLang,
): Generator<ParsedDictEntry> {
  // CC-CEDICT is always English — the targetLang arg is a no-op there.
  return format === "jmdict" ? parseJMdict(text, targetLang) : parseCedict(text);
}

/**
 * Parse a raw dictionary text blob and install it into the database:
 *   1. Insert a row in `dictionaries` with an id and metadata.
 *   2. Stream parsed entries into `dict_entries` (FTS5) in a single
 *      transaction for throughput (~1s per 100k entries on SSD).
 *
 * If parsing yields zero entries we roll back and throw — a malformed
 * file should not leave an empty dictionary sitting in the list.
 */
export function installDictionary(params: {
  name: string;
  format: DictFormat;
  sourceLang: DictSourceLang;
  targetLang: DictTargetLang;
  text: string;
}): InstallResult {
  const { name, format, sourceLang, targetLang, text } = params;
  const sqlite = getSqlite();
  const db = getDb();

  const id = randomUUID();
  const insertEntry = sqlite.prepare(
    "INSERT INTO dict_entries (dictionary_id, headword, reading, gloss) VALUES (?, ?, ?, ?)",
  );

  let entryCount = 0;
  const installTx = sqlite.transaction(() => {
    for (const entry of entriesFor(format, text, targetLang)) {
      insertEntry.run(id, entry.headword, entry.reading, entry.gloss);
      entryCount++;
    }
  });
  installTx();

  if (entryCount === 0) {
    // Roll back conceptually — nothing was written to `dictionaries` yet.
    throw new Error("No valid entries found in dictionary file for target language");
  }

  db.insert(dictionaries)
    .values({
      id,
      name,
      format,
      sourceLang,
      targetLang,
      entryCount,
    })
    .run();

  return { id, name, format, sourceLang, targetLang, entryCount };
}

export function uninstallDictionary(id: string): boolean {
  const sqlite = getSqlite();
  const db = getDb();

  // FTS5 tables don't cascade, so delete entries explicitly first.
  sqlite.prepare("DELETE FROM dict_entries WHERE dictionary_id = ?").run(id);

  const result = db
    .delete(dictionaries)
    .where(eq(dictionaries.id, id))
    .run();

  return result.changes > 0;
}

export function listDictionaries() {
  const db = getDb();
  return db.select().from(dictionaries).all();
}
