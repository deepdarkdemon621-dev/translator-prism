import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { ensureDataDir } from "@/lib/db/init";
import { books, chapters, paragraphs, translations, users } from "@/lib/db/schema";
import { desc, eq, and, or, inArray, isNull, sql } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";

export async function GET(request: NextRequest) {
  ensureDataDir();
  const db = getDb();
  const user = await getCurrentUser();
  const scope = request.nextUrl.searchParams.get("scope");

  // Library for a regular user = their own uploads + public books that
  // an admin uploaded. Public books uploaded by other regular users stay
  // hidden — each regular user is siloed from the others. Admin sees
  // everything regardless.
  //
  // We narrow "admin-uploaded public" by first collecting admin user ids.
  // ADMIN_EMAILS is the source of truth for admin, but the is_admin flag
  // on users is kept in sync on every sign-in (see auth.ts), so reading
  // users.is_admin here is correct.
  let whereClause;
  if (user.isAdmin) {
    whereClause = undefined;
  } else {
    const adminIds = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.isAdmin, 1))
        .all()
    ).map((u) => u.id);
    const adminPublic = adminIds.length
      ? and(eq(books.visibility, "public"), inArray(books.userId, adminIds))
      : undefined;
    whereClause = adminPublic
      ? or(eq(books.userId, user.id), adminPublic)
      : eq(books.userId, user.id);
  }

  const query = db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      sourceLang: books.sourceLang,
      coverPath: books.coverPath,
      totalChapters: books.totalChapters,
      status: books.status,
      userId: books.userId,
      visibility: books.visibility,
      collectionId: books.collectionId,
      createdAt: books.createdAt,
    })
    .from(books);

  const finalWhere =
    scope === "top"
      ? whereClause
        ? and(whereClause, isNull(books.collectionId))
        : isNull(books.collectionId)
      : whereClause;

  // Manually ordered books (library_seq set) first in their chosen order;
  // never-ordered ones keep the old newest-first ordering after them.
  const allBooks = await (finalWhere ? query.where(finalWhere) : query)
    .orderBy(
      sql`CASE WHEN ${books.librarySeq} IS NULL THEN 1 ELSE 0 END`,
      books.librarySeq,
      desc(books.createdAt),
    )
    .all();

  // Count "done" chapters + pending/processing translations per book. The
  // pending count drives the Cancel button in the UI — it's non-zero
  // exactly when there is work the user could abort.
  //
  // Previously this used Promise.all with three queries per book (done
  // chapter count, paragraph ids fetch, pending translation count),
  // producing ~3N+1 DB round-trips that scaled linearly with library
  // size. Now it's two batched aggregations keyed by book_id regardless
  // of N. Relies on idx_chapters_book_status + idx_translations_paragraph_status
  // (migration 0009) so neither query needs a full-table scan.
  const bookIds = allBooks.map((b) => b.id);
  const doneByBook = new Map<string, number>();
  const pendingByBook = new Map<string, number>();
  if (bookIds.length) {
    const doneRows = await db
      .select({
        bookId: chapters.bookId,
        count: sql<number>`SUM(CASE WHEN ${chapters.status} = 'done' OR (
          NOT EXISTS (
            SELECT 1 FROM paragraphs p_text
            WHERE p_text.chapter_id = ${chapters.id} AND p_text.kind = 'text'
          )
          AND EXISTS (
            SELECT 1 FROM paragraphs p_any
            WHERE p_any.chapter_id = ${chapters.id}
          )
        ) THEN 1 ELSE 0 END)`,
      })
      .from(chapters)
      .where(inArray(chapters.bookId, bookIds))
      .groupBy(chapters.bookId)
      .all();
    for (const r of doneRows) doneByBook.set(r.bookId, Number(r.count));

    const pendingRows = await db
      .select({
        bookId: chapters.bookId,
        count: sql<number>`COUNT(*)`,
      })
      .from(translations)
      .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
      .innerJoin(chapters, eq(paragraphs.chapterId, chapters.id))
      .where(
        and(
          inArray(chapters.bookId, bookIds),
          inArray(translations.status, ["pending", "processing"]),
        ),
      )
      .groupBy(chapters.bookId)
      .all();
    for (const r of pendingRows) pendingByBook.set(r.bookId, Number(r.count));
  }

  const booksWithProgress = allBooks.map((book) => ({
    ...book,
    translatedChapters: doneByBook.get(book.id) ?? 0,
    pendingTranslations: pendingByBook.get(book.id) ?? 0,
  }));

  return NextResponse.json(booksWithProgress);
}
