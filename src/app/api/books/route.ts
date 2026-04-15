import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { ensureDataDir } from "@/lib/db/init";
import { books, chapters, paragraphs, translations, users } from "@/lib/db/schema";
import { desc, eq, and, count, or, inArray, isNull } from "drizzle-orm";
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

  const allBooks = await (finalWhere ? query.where(finalWhere) : query)
    .orderBy(desc(books.createdAt))
    .all();

  // Count "done" chapters + pending/processing translations per book. The
  // pending count drives the Cancel button in the UI — it's non-zero
  // exactly when there is work the user could abort.
  const booksWithProgress = await Promise.all(
    allBooks.map(async (book) => {
      const doneChapters = await db
        .select({ count: count() })
        .from(chapters)
        .where(and(eq(chapters.bookId, book.id), eq(chapters.status, "done")))
        .all();

      // Sub-select: paragraphs in this book → translations still in flight.
      const paraIds = (
        await db
          .select({ id: paragraphs.id })
          .from(paragraphs)
          .innerJoin(chapters, eq(chapters.id, paragraphs.chapterId))
          .where(eq(chapters.bookId, book.id))
          .all()
      ).map((p) => p.id);

      const pendingCount = paraIds.length
        ? (
            await db
              .select({ count: count() })
              .from(translations)
              .where(
                and(
                  inArray(translations.paragraphId, paraIds),
                  inArray(translations.status, ["pending", "processing"]),
                ),
              )
              .all()
          )[0]?.count || 0
        : 0;

      return {
        ...book,
        translatedChapters: doneChapters[0]?.count || 0,
        pendingTranslations: pendingCount,
      };
    }),
  );

  return NextResponse.json(booksWithProgress);
}
