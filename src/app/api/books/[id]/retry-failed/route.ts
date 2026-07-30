import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { chapters, paragraphs, translations } from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { loadBookForWrite } from "@/lib/access";

// Match the global retry route's chunk size (Turso param limits).
const UPDATE_CHUNK = 500;

/**
 * Reset this book's `failed` translations back to `pending` so the worker
 * picks them up again. Per-book variant of /api/translations/retry-failed
 * for the library card's "Retry failed" action — the global route resets
 * every visible book at once, which is too blunt when one book is stuck.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await loadBookForWrite(id);
  if (!result.book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }
  if (result.forbidden) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const db = getDb();
  const failedRows = await db
    .select({ id: translations.id })
    .from(translations)
    .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
    .innerJoin(chapters, eq(paragraphs.chapterId, chapters.id))
    .where(and(eq(chapters.bookId, id), eq(translations.status, "failed")))
    .all();

  if (failedRows.length === 0) {
    return NextResponse.json({ reset: 0 });
  }

  const now = new Date().toISOString();
  const ids = failedRows.map((r) => r.id);
  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
      await tx
        .update(translations)
        .set({
          status: "pending",
          errorMessage: null,
          claimedBy: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(inArray(translations.id, ids.slice(i, i + UPDATE_CHUNK)));
    }
  });

  return NextResponse.json({ reset: ids.length });
}
