// In-payload dedupe for the book import route. Export payloads are external
// input; nothing guarantees a paragraph's translations array holds one entry
// per language. Until (and after) the 0014 unique index, imports must land at
// most one row per (paragraph_id, lang).

export interface ImportTranslationRow {
  id: string;
  paragraphId: string;
  lang: string;
  text: string;
  status: string;
  model: string | null;
  tokensUsed: number | null;
}

function isCompleted(row: ImportTranslationRow): boolean {
  return row.status === "done" && row.text.trim() !== "";
}

/**
 * Keep one row per (paragraphId, lang): the first completed non-empty
 * candidate in payload order, else the first candidate. Deterministic so a
 * re-imported payload produces identical rows.
 */
export function dedupeImportTranslationRows<T extends ImportTranslationRow>(
  rows: T[],
): { rows: T[]; dropped: number } {
  const byKey = new Map<string, T>();
  const order: string[] = [];
  for (const row of rows) {
    const key = `${row.paragraphId}|${row.lang}`;
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, row);
      order.push(key);
      continue;
    }
    if (!isCompleted(prior) && isCompleted(row)) {
      byKey.set(key, row);
    }
  }
  const deduped = order.map((key) => byKey.get(key)!);
  return { rows: deduped, dropped: rows.length - deduped.length };
}
