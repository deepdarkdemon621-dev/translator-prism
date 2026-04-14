import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, chapters, collections, collectionBooks } from "@/lib/db/schema";
import { and, asc, count, eq } from "drizzle-orm";
import { loadOwnedCollection } from "@/lib/collections";

/**
 * GET: full collection detail — metadata + ordered book list with the
 * same progress/cover fields the library grid consumes. Drives the
 * /collection/[id] page in one round-trip.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { collection } = await loadOwnedCollection(id);
  if (!collection) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const db = getDb();
  const rows = db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      sourceLang: books.sourceLang,
      coverPath: books.coverPath,
      totalChapters: books.totalChapters,
      status: books.status,
      seq: collectionBooks.seq,
    })
    .from(collectionBooks)
    .innerJoin(books, eq(books.id, collectionBooks.bookId))
    .where(eq(collectionBooks.collectionId, id))
    .orderBy(asc(collectionBooks.seq), asc(collectionBooks.createdAt))
    .all();

  const decorated = rows.map((b) => {
    const doneRow = db
      .select({ n: count() })
      .from(chapters)
      .where(and(eq(chapters.bookId, b.id), eq(chapters.status, "done")))
      .all();
    return { ...b, translatedChapters: doneRow[0]?.n || 0 };
  });

  return NextResponse.json({
    id: collection.id,
    name: collection.name,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
    books: decorated,
  });
}

/**
 * PUT: rename. Only `name` is editable — the cover auto-derives and
 * there's no other user-facing knob.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { collection } = await loadOwnedCollection(id);
  if (!collection) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Name required" }, { status: 400 });
  }
  if (name.length > 120) {
    return NextResponse.json({ error: "Name too long" }, { status: 400 });
  }

  const db = getDb();
  db.update(collections)
    .set({ name, updatedAt: new Date().toISOString() })
    .where(eq(collections.id, id))
    .run();

  return NextResponse.json({ id, name });
}

/**
 * DELETE: removes the collection + cascade-drops membership rows.
 * The underlying books stay — this is a "dissolve the shelf", not a
 * "burn the books" operation.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { collection } = await loadOwnedCollection(id);
  if (!collection) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const db = getDb();
  db.delete(collections).where(eq(collections.id, id)).run();
  return NextResponse.json({ success: true });
}
