import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { ensureDataDir } from "@/lib/db/init";
import { books, collections, collectionBooks } from "@/lib/db/schema";
import { asc, desc, eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { randomUUID } from "crypto";

/**
 * GET: a user's collections, each decorated with its derived cover
 * (first book's cover) and book count. Kept in one round-trip — the
 * home page renders this list before it renders the book grid, so we
 * don't want to wait on N+1 follow-up fetches.
 *
 * Collections are per-user: you see yours, admin sees theirs. No
 * cross-tenant visibility even for admin, because a bulk-translate
 * sweep keyed off someone else's collection would be surprising.
 */
export async function GET() {
  ensureDataDir();
  const user = await getCurrentUser();
  const db = getDb();

  const rows = db
    .select()
    .from(collections)
    .where(eq(collections.userId, user.id))
    .orderBy(desc(collections.updatedAt))
    .all();

  const decorated = rows.map((c) => {
    // "First" book = smallest seq. Tie-break by createdAt so stable.
    const first = db
      .select({
        id: books.id,
        title: books.title,
        coverPath: books.coverPath,
      })
      .from(collectionBooks)
      .innerJoin(books, eq(books.id, collectionBooks.bookId))
      .where(eq(collectionBooks.collectionId, c.id))
      .orderBy(asc(collectionBooks.seq), asc(collectionBooks.createdAt))
      .limit(1)
      .all();

    const countRow = db
      .select({ bookId: collectionBooks.bookId })
      .from(collectionBooks)
      .where(eq(collectionBooks.collectionId, c.id))
      .all();

    return {
      id: c.id,
      name: c.name,
      bookCount: countRow.length,
      coverBookId: first[0]?.id ?? null,
      coverPath: first[0]?.coverPath ?? null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  });

  return NextResponse.json(decorated);
}

/**
 * POST: create a new collection. Only `name` is settable; cover follows
 * from membership so there's nothing else to pick at creation time.
 */
export async function POST(request: NextRequest) {
  ensureDataDir();
  const user = await getCurrentUser();
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Name required" }, { status: 400 });
  }
  if (name.length > 120) {
    return NextResponse.json({ error: "Name too long" }, { status: 400 });
  }

  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(collections)
    .values({ id, userId: user.id, name, createdAt: now, updatedAt: now })
    .run();

  // If the payload included bookIds, append them in order. Handy for
  // "new collection from selection" flows so the client doesn't have
  // to do a creation + N POSTs.
  if (Array.isArray(body.bookIds)) {
    let seq = 0;
    for (const bookId of body.bookIds) {
      if (typeof bookId !== "string") continue;
      // Only link books the caller actually owns / can see. Admin sees
      // all; other users see their own + public.
      const book = db
        .select({ id: books.id, userId: books.userId, visibility: books.visibility })
        .from(books)
        .where(eq(books.id, bookId))
        .get();
      if (!book) continue;
      const canUse =
        user.isAdmin || book.userId === user.id || book.visibility === "public";
      if (!canUse) continue;
      db.insert(collectionBooks)
        .values({
          collectionId: id,
          bookId,
          seq: seq++,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
    }
  }

  return NextResponse.json({ id, name });
}

