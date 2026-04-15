import { getDb } from "@/lib/db";
import { books, chapters, paragraphs, translations } from "@/lib/db/schema";
import { and, eq, inArray, ne } from "drizzle-orm";
import { getTranslationQueue } from "@/lib/queue/translation-queue";
import { checkChapterDone } from "@/lib/chapter-status";

/**
 * Re-enqueue every translation that was mid-flight when the process died.
 *
 * The queue lives only in RAM — a restart drops all in-memory jobs but the
 * rows in `translations` still read "pending" or "processing". Without
 * this pass, the reader would sit forever polling a chapter that nobody
 * is translating.
 *
 * Idempotent: the queue callbacks upsert by translation id, so re-queueing
 * a row that happens to finish before the queue fires again is harmless.
 * Intended to be called exactly once at process startup (from
 * instrumentation.ts).
 */
export async function resumePendingTranslations(): Promise<{
  requeued: number;
}> {
  const db = getDb();

  // Pull every non-terminal translation in one shot. Volume is bounded by
  // "paragraphs the user started translating and never finished" — a
  // user with a single in-flight book has at most a few hundred rows.
  const pending = await db
    .select({
      id: translations.id,
      paragraphId: translations.paragraphId,
      lang: translations.lang,
    })
    .from(translations)
    .where(inArray(translations.status, ["pending", "processing"]))
    .all();

  if (pending.length === 0) return { requeued: 0 };

  // Join up to paragraph → chapter → book so we know the source language
  // and source text for each job. Batch-select in chunks to avoid a SQL
  // IN list blowup on very large restarts.
  const paraIds = Array.from(new Set(pending.map((t) => t.paragraphId)));
  const paraRows = await db
    .select({
      id: paragraphs.id,
      chapterId: paragraphs.chapterId,
      sourceText: paragraphs.sourceText,
    })
    .from(paragraphs)
    .where(inArray(paragraphs.id, paraIds))
    .all();
  const paraMap = new Map(paraRows.map((p) => [p.id, p]));

  const chapterIds = Array.from(new Set(paraRows.map((p) => p.chapterId)));
  const chapterRows = await db
    .select({ id: chapters.id, bookId: chapters.bookId })
    .from(chapters)
    .where(inArray(chapters.id, chapterIds))
    .all();
  const chapterToBook = new Map(chapterRows.map((c) => [c.id, c.bookId]));

  const bookIds = Array.from(new Set(chapterRows.map((c) => c.bookId)));
  const bookRows = await db
    .select({ id: books.id, sourceLang: books.sourceLang })
    .from(books)
    .where(inArray(books.id, bookIds))
    .all();
  const bookLang = new Map(bookRows.map((b) => [b.id, b.sourceLang]));

  const queue = getTranslationQueue();
  let requeued = 0;

  for (const t of pending) {
    const para = paraMap.get(t.paragraphId);
    if (!para) continue;
    const chapterId = para.chapterId;
    const bookId = chapterToBook.get(chapterId);
    if (!bookId) continue;
    const sourceLang = bookLang.get(bookId);
    if (!sourceLang) continue;

    // Reset status to 'pending' in case we caught it mid-processing —
    // the worker that "owned" the processing row is long dead.
    await db
      .update(translations)
      .set({
        status: "pending",
        errorMessage: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(translations.id, t.id))
      .run();

    const translationId = t.id;
    queue.add({
      translationId,
      text: para.sourceText,
      fromLang: sourceLang,
      toLang: t.lang,
      shouldRun: () => true,
      onComplete: (result) => {
        void (async () => {
          await getDb()
            .update(translations)
            .set({
              text: result.text,
              status: "done",
              model: result.model,
              tokensUsed: result.tokensUsed,
              updatedAt: new Date().toISOString(),
            })
            .where(
              and(
                eq(translations.id, translationId),
                ne(translations.status, "cancelled"),
              ),
            )
            .run();
          await checkChapterDone(chapterId);
        })();
      },
      onError: (error) => {
        void (async () => {
          await getDb()
            .update(translations)
            .set({
              status: "failed",
              errorMessage: error.message,
              updatedAt: new Date().toISOString(),
            })
            .where(
              and(
                eq(translations.id, translationId),
                ne(translations.status, "cancelled"),
              ),
            )
            .run();
          await checkChapterDone(chapterId);
        })();
      },
    });
    requeued++;
  }

  return { requeued };
}
