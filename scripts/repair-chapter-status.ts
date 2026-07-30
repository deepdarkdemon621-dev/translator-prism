// One-time repair for chapters stranded by the pre-bulk-enqueue translate-all
// route (Vercel timeouts left book tails un-enqueued) and by pre-`kind`
// imports (image-only chapters never marked done). Classifies every not-done
// chapter and, on --apply, routes each book's stranded chapters through
// enqueueChaptersBulk(): image-only chapters get marked done, text chapters
// with no translation rows get enqueued, zero-paragraph legacy chapters get
// extracted (and then enqueued or marked done).
//
//   npx tsx scripts/repair-chapter-status.ts                  # dry-run, read-only
//   npx tsx scripts/repair-chapter-status.ts --apply          # writes production
//   npx tsx scripts/repair-chapter-status.ts --book <id>      # limit to one book
//   npx tsx scripts/repair-chapter-status.ts --skip-book <id> # exclude a book (repeatable)
//
// Env resolution matches the worker: explicit env wins, then .env.worker,
// then .env.local, then .env.
import { config as loadEnv } from "dotenv";
import path from "path";

loadEnv({ path: path.join(process.cwd(), ".env.worker"), quiet: true });
loadEnv({ path: path.join(process.cwd(), ".env.local"), quiet: true });
loadEnv({ quiet: true });

interface RepairChapter {
  chapterId: string;
  bookId: string;
  bookTitle: string;
  sourceLang: string;
  category: "zero_paragraphs" | "image_only" | "never_enqueued";
  estimatedRows: number;
}

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
  const skipBooks = new Set<string>();
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--skip-book" && process.argv[i + 1]) {
      skipBooks.add(process.argv[i + 1]);
    }
  }

  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is required");
  console.log(
    `[repair] target=${describeTarget(url)} mode=${apply ? "APPLY" : "dry-run"}${onlyBook ? ` book=${onlyBook}` : ""}`,
  );

  // Import after env load so getDb() sees the worker credentials.
  const { getLibsqlClient } = await import("../src/lib/db");
  const { enqueueChaptersBulk } = await import("../src/lib/translate/enqueue");
  const client = getLibsqlClient();

  const bookFilter = onlyBook ? "AND b.id = ?" : "";
  const args = onlyBook ? [onlyBook] : [];

  const classify = async (): Promise<RepairChapter[]> => {
    const rows = await client.execute({
      sql: `
        SELECT c.id AS chapterId, b.id AS bookId, b.title AS bookTitle,
               b.source_lang AS sourceLang,
          CASE
            WHEN NOT EXISTS (SELECT 1 FROM paragraphs p WHERE p.chapter_id = c.id)
              THEN 'zero_paragraphs'
            WHEN NOT EXISTS (SELECT 1 FROM paragraphs p WHERE p.chapter_id = c.id AND p.kind = 'text')
              THEN 'image_only'
            WHEN NOT EXISTS (
              SELECT 1 FROM translations t
              JOIN paragraphs p2 ON p2.id = t.paragraph_id
              WHERE p2.chapter_id = c.id
            ) THEN 'never_enqueued'
            ELSE NULL
          END AS category,
          (SELECT COUNT(*) FROM paragraphs p3
            WHERE p3.chapter_id = c.id AND p3.kind = 'text'
              AND NOT EXISTS (
                SELECT 1 FROM translations t2 WHERE t2.paragraph_id = p3.id
              )
          ) * 2 AS estimatedRows
        FROM chapters c JOIN books b ON b.id = c.book_id
        WHERE c.status != 'done' ${bookFilter}
        ORDER BY b.title, c."index"`,
      args,
    });
    return rows.rows
      .filter((r) => r.category != null && !skipBooks.has(String(r.bookId)))
      .map((r) => ({
        chapterId: String(r.chapterId),
        bookId: String(r.bookId),
        bookTitle: String(r.bookTitle),
        sourceLang: String(r.sourceLang),
        category: r.category as RepairChapter["category"],
        estimatedRows: Number(r.estimatedRows),
      }));
  };

  const pendingCount = async (): Promise<number> => {
    const res = await client.execute(
      "SELECT COUNT(*) c FROM translations WHERE status = 'pending'",
    );
    return Number(res.rows[0]?.c ?? 0);
  };

  const chaptersBefore = await classify();
  const pendingBefore = await pendingCount();

  const byBook = new Map<string, RepairChapter[]>();
  for (const ch of chaptersBefore) {
    const list = byBook.get(ch.bookId) ?? [];
    list.push(ch);
    byBook.set(ch.bookId, list);
  }

  console.log(`[repair] pending before: ${pendingBefore}`);
  console.log(`[repair] stranded chapters: ${chaptersBefore.length} across ${byBook.size} book(s)`);
  let totalEstimated = 0;
  for (const [, list] of byBook) {
    const title = list[0].bookTitle.slice(0, 32);
    const zero = list.filter((c) => c.category === "zero_paragraphs").length;
    const img = list.filter((c) => c.category === "image_only").length;
    const never = list.filter((c) => c.category === "never_enqueued").length;
    const est = list.reduce((sum, c) => sum + c.estimatedRows, 0);
    totalEstimated += est;
    console.log(
      `  ${title.padEnd(32)} lang=${list[0].sourceLang} zeroParas=${zero} imageOnly=${img} neverEnqueued=${never} estRows=${est}`,
    );
  }
  console.log(
    `[repair] estimated new pending rows (excl. zero-paragraph chapters, unknown until extraction): ${totalEstimated}`,
  );

  if (!apply) {
    console.log("[repair] dry-run complete; re-run with --apply to write.");
    return;
  }

  let queued = 0;
  let imageOnlyMarkedDone = 0;
  let extracted = 0;
  for (const [bookId, list] of byBook) {
    const res = await enqueueChaptersBulk(
      list.map((c) => c.chapterId),
      list[0].sourceLang,
    );
    queued += res.queued;
    imageOnlyMarkedDone += res.imageOnlyMarkedDone;
    extracted += res.extractedChapters;
    console.log(
      `  [apply] ${list[0].bookTitle.slice(0, 32)} (${bookId.slice(0, 8)}): queued=${res.queued} imageOnlyDone=${res.imageOnlyMarkedDone} extracted=${res.extractedChapters} skippedDone=${res.skippedDone}`,
    );
  }

  const chaptersAfter = await classify();
  const pendingAfter = await pendingCount();
  console.log(
    `[repair] APPLY complete: queued=${queued} imageOnlyMarkedDone=${imageOnlyMarkedDone} extractedChapters=${extracted}`,
  );
  console.log(
    `[repair] stranded chapters after: ${chaptersAfter.length}; pending ${pendingBefore} -> ${pendingAfter}`,
  );
}

main().catch((err) => {
  console.error("[repair] failed:", err);
  process.exitCode = 1;
});
