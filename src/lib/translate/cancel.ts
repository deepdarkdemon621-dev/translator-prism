import { getDb } from "@/lib/db";
import { chapters, paragraphs, translations } from "@/lib/db/schema";
import { and, eq, inArray, ne } from "drizzle-orm";

/**
 * Soft-cancel every non-done translation for a book.
 *
 * We don't touch rows that are already 'done' (user wants to keep those)
 * or already 'cancelled'. In-flight jobs at the provider level can't be
 * aborted — their results will be dropped on arrival by the WHERE
 * status != 'cancelled' guard in the queue callbacks, so no stale writes
 * sneak in.
 *
 * Chapters that were mid-translation get their status reset to 'pending'
 * so the reader doesn't show them as "translating" forever. Chapters that
 * are already 'done' are left alone.
 */
export function cancelBookTranslations(bookId: string): {
  cancelled: number;
  chaptersReset: number;
} {
  const db = getDb();

  // Pull every paragraph in this book via chapter → paragraph join
  // (drizzle doesn't offer a clean nested IN, so we walk it in two steps).
  const chapterRows = db
    .select({ id: chapters.id, status: chapters.status })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .all();
  if (chapterRows.length === 0) return { cancelled: 0, chaptersReset: 0 };

  const chapterIds = chapterRows.map((c) => c.id);
  const paraRows = db
    .select({ id: paragraphs.id })
    .from(paragraphs)
    .where(inArray(paragraphs.chapterId, chapterIds))
    .all();
  if (paraRows.length === 0) return { cancelled: 0, chaptersReset: 0 };

  const paraIds = paraRows.map((p) => p.id);

  // Bulk update: mark every non-terminal translation as cancelled. We
  // treat 'pending' and 'processing' as cancellable; 'done'/'failed'/
  // already-'cancelled' stay put. We count rows that transition.
  const beforeCount = db
    .select({ id: translations.id })
    .from(translations)
    .where(
      and(
        inArray(translations.paragraphId, paraIds),
        inArray(translations.status, ["pending", "processing"]),
      ),
    )
    .all();

  if (beforeCount.length === 0) return { cancelled: 0, chaptersReset: 0 };

  db.update(translations)
    .set({ status: "cancelled", updatedAt: new Date().toISOString() })
    .where(
      and(
        inArray(translations.paragraphId, paraIds),
        inArray(translations.status, ["pending", "processing"]),
      ),
    )
    .run();

  // Reset chapters that were 'translating' back to 'pending' so the UI
  // stops showing them as in-flight. Skip chapters that are already 'done'
  // — their rows weren't touched above. We leave 'error' alone too (user
  // still sees the failed state, accurate).
  let chaptersReset = 0;
  for (const ch of chapterRows) {
    if (ch.status !== "translating") continue;
    db.update(chapters)
      .set({ status: "pending", updatedAt: new Date().toISOString() })
      .where(and(eq(chapters.id, ch.id), ne(chapters.status, "done")))
      .run();
    chaptersReset++;
  }

  return { cancelled: beforeCount.length, chaptersReset };
}
