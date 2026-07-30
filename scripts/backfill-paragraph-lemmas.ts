// Backfill the paragraph_lemmas corpus index (L4): tokenize every text
// paragraph of Japanese books that has no lemma row yet and insert the
// space-joined base forms. The FTS mirror updates via triggers (0017).
// Idempotent — re-run after uploading new Japanese books.
//
//   npx tsx scripts/backfill-paragraph-lemmas.ts             # dry-run: counts only
//   npx tsx scripts/backfill-paragraph-lemmas.ts --apply     # write rows
//   npx tsx scripts/backfill-paragraph-lemmas.ts --book <id> # limit to one book
//
// Env resolution matches the worker: explicit env wins, then .env.worker,
// then .env.local, then .env.
import { config as loadEnv } from "dotenv";
import path from "path";

loadEnv({ path: path.join(process.cwd(), ".env.worker"), quiet: true });
loadEnv({ path: path.join(process.cwd(), ".env.local"), quiet: true });
loadEnv({ quiet: true });

const BATCH = 200;

function describeTarget(url: string): string {
  if (url.startsWith("file:")) return url;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return "(unparseable url)";
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const bookFlag = process.argv.indexOf("--book");
  const onlyBook = bookFlag >= 0 ? process.argv[bookFlag + 1] : null;

  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is required");
  console.log(
    `[lemmas] target=${describeTarget(url)} mode=${apply ? "APPLY" : "dry-run"}${onlyBook ? ` book=${onlyBook}` : ""}`,
  );

  const { getLibsqlClient } = await import("../src/lib/db");
  const { lemmasForText } = await import("../src/lib/learning/tokenize");
  const client = getLibsqlClient();

  const bookFilter = onlyBook ? "AND b.id = ?" : "";
  const args = onlyBook ? [onlyBook] : [];

  const missing = await client.execute({
    sql: `SELECT COUNT(*) c
      FROM paragraphs p
      JOIN chapters c2 ON c2.id = p.chapter_id
      JOIN books b ON b.id = c2.book_id
      WHERE b.source_lang = 'ja' AND p.kind = 'text'
        AND NOT EXISTS (SELECT 1 FROM paragraph_lemmas pl WHERE pl.paragraph_id = p.id)
        ${bookFilter}`,
    args,
  });
  const total = Number(missing.rows[0]?.c ?? 0);
  console.log(`[lemmas] paragraphs missing lemma rows: ${total}`);
  if (!apply) {
    console.log("[lemmas] dry-run complete; re-run with --apply to write.");
    return;
  }

  let processed = 0;
  for (;;) {
    const rows = await client.execute({
      sql: `SELECT p.id, p.source_text
        FROM paragraphs p
        JOIN chapters c2 ON c2.id = p.chapter_id
        JOIN books b ON b.id = c2.book_id
        WHERE b.source_lang = 'ja' AND p.kind = 'text'
          AND NOT EXISTS (SELECT 1 FROM paragraph_lemmas pl WHERE pl.paragraph_id = p.id)
          ${bookFilter}
        LIMIT ${BATCH}`,
      args,
    });
    if (rows.rows.length === 0) break;

    const statements = [];
    for (const row of rows.rows) {
      const lemmas = await lemmasForText(String(row.source_text));
      statements.push({
        sql: "INSERT OR IGNORE INTO paragraph_lemmas (paragraph_id, lemmas) VALUES (?, ?)",
        args: [String(row.id), lemmas.join(" ")],
      });
    }
    await client.batch(statements, "write");
    processed += rows.rows.length;
    console.log(`[lemmas] ${processed}/${total}`);
  }

  console.log(`[lemmas] APPLY complete: ${processed} paragraphs indexed.`);
}

main().catch((err) => {
  console.error("[lemmas] failed:", err);
  process.exitCode = 1;
});
