import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  books,
  chapters,
  paragraphs,
  translations,
  users,
} from "@/lib/db/schema";
import { and, eq, inArray, or } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";

// Match enqueue.ts's batch size. Turso's statement param limit is ~500
// for our row width; keeps the chunked UPDATE well inside that.
const UPDATE_CHUNK = 500;

/**
 * Reset every `failed` translation in the caller's visible books to
 * `pending` so the worker picks them up again. Used from the /progress
 * page after the user tops up their API balance or fixes their key.
 *
 * Scope mirrors /api/books GET: admin resets everything, regular users
 * reset only within their own uploads + admin-public books. Without the
 * scope a regular user could pay the worker's time resetting a book they
 * don't own.
 */
export async function POST() {
  const user = await getCurrentUser();
  const db = getDb();

  // Resolve visible book IDs. Duplicate logic from
  // /api/translation-progress, but inlining is cleaner than shipping a
  // shared helper for two call sites.
  let bookIds: string[];
  if (user.isAdmin) {
    bookIds = (await db.select({ id: books.id }).from(books).all()).map(
      (b) => b.id,
    );
  } else {
    const adminIds = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.isAdmin, 1))
        .all()
    ).map((u) => u.id);
    const visible = adminIds.length
      ? or(
          eq(books.userId, user.id),
          and(eq(books.visibility, "public"), inArray(books.userId, adminIds)),
        )
      : eq(books.userId, user.id);
    bookIds = (
      await db.select({ id: books.id }).from(books).where(visible).all()
    ).map((b) => b.id);
  }

  if (bookIds.length === 0) {
    return NextResponse.json({ reset: 0 });
  }

  // Collect translation IDs first so we can UPDATE by primary key in
  // chunks. Doing the UPDATE as a single statement with a subquery would
  // also work but hits Turso's param-expansion limits on big books.
  const failedRows = await db
    .select({ id: translations.id })
    .from(translations)
    .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
    .innerJoin(chapters, eq(paragraphs.chapterId, chapters.id))
    .where(
      and(
        inArray(chapters.bookId, bookIds),
        eq(translations.status, "failed"),
      ),
    )
    .all();

  if (failedRows.length === 0) {
    return NextResponse.json({ reset: 0 });
  }

  const now = new Date().toISOString();
  const ids = failedRows.map((r) => r.id);
  let reset = 0;
  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
      const chunk = ids.slice(i, i + UPDATE_CHUNK);
      const res = await tx
        .update(translations)
        .set({ status: "pending", errorMessage: null, updatedAt: now })
        .where(inArray(translations.id, chunk));
      // Drizzle's libsql dialect doesn't consistently expose rowsAffected;
      // count the chunk length instead, which matches what we just set.
      reset += chunk.length;
      void res;
    }
  });

  return NextResponse.json({ reset });
}
