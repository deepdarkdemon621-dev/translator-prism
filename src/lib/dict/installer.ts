import { randomUUID } from "crypto";
import { getDb, getLibsqlClient } from "@/lib/db";
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
 *      transaction for throughput.
 *
 * If parsing yields zero entries we roll back and throw — a malformed
 * file should not leave an empty dictionary sitting in the list.
 */
export async function installDictionary(params: {
  name: string;
  format: DictFormat;
  sourceLang: DictSourceLang;
  targetLang: DictTargetLang;
  text: string;
}): Promise<InstallResult> {
  const { name, format, sourceLang, targetLang, text } = params;
  const client = getLibsqlClient();
  const db = getDb();

  const id = randomUUID();

  // Collect entries first so we can detect the zero-entry case without
  // leaving partial FTS rows. For large dictionaries this still fits in
  // memory comfortably (JMdict ~200k entries).
  const batch: Array<{ sql: string; args: (string | null)[] }> = [];
  for (const entry of entriesFor(format, text, targetLang)) {
    batch.push({
      sql:
        "INSERT INTO dict_entries (dictionary_id, headword, reading, gloss) VALUES (?, ?, ?, ?)",
      args: [id, entry.headword, entry.reading, entry.gloss],
    });
  }

  if (batch.length === 0) {
    throw new Error(
      "No valid entries found in dictionary file for target language",
    );
  }

  // libsql `.batch()` runs the statements in a single implicit transaction
  // and rolls back on any failure — equivalent to the old better-sqlite3
  // `transaction()` helper for throughput and atomicity.
  await client.batch(batch, "write");

  await db
    .insert(dictionaries)
    .values({
      id,
      name,
      format,
      sourceLang,
      targetLang,
      entryCount: batch.length,
    })
    .run();

  return {
    id,
    name,
    format,
    sourceLang,
    targetLang,
    entryCount: batch.length,
  };
}

export async function uninstallDictionary(id: string): Promise<boolean> {
  const client = getLibsqlClient();
  const db = getDb();

  // FTS5 tables don't cascade, so delete entries explicitly first.
  await client.execute({
    sql: "DELETE FROM dict_entries WHERE dictionary_id = ?",
    args: [id],
  });

  const result = await db
    .delete(dictionaries)
    .where(eq(dictionaries.id, id))
    .run();

  return result.rowsAffected > 0;
}

export async function listDictionaries() {
  const db = getDb();
  return await db.select().from(dictionaries).all();
}
