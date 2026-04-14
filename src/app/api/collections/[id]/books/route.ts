import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { collectionBooks, collections } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import {
  appendBookToCollection,
  canUseBookInCollection,
  loadOwnedCollection,
} from "@/lib/collections";

/**
 * POST: add a single book to the collection. Body: { bookId }. The row
 * gets appended to the tail (new seq = current max + 1) so it won't
 * steal the cover from whatever is already first. Idempotent on
 * duplicates thanks to the composite PK.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { user, collection } = await loadOwnedCollection(id);
  if (!collection) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body = await request.json().catch(() => ({}));
  const bookId = typeof body.bookId === "string" ? body.bookId : "";
  if (!bookId) {
    return NextResponse.json({ error: "bookId required" }, { status: 400 });
  }
  if (!canUseBookInCollection(user, bookId)) {
    return NextResponse.json({ error: "Book not accessible" }, { status: 403 });
  }

  appendBookToCollection(id, bookId);
  getDb()
    .update(collections)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(collections.id, id))
    .run();

  return NextResponse.json({ success: true });
}

/**
 * PUT: reorder the membership list. Body: { order: bookId[] } — the
 * seq assigned to each book equals its index in the array. This is
 * also how the user changes "which book is the cover" (first in the
 * list wins).
 *
 * Any book in the payload that isn't currently a member is silently
 * dropped rather than inserted; use POST to add, then PUT to reorder.
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
  const order: string[] = Array.isArray(body.order) ? body.order : [];
  if (order.length === 0) {
    return NextResponse.json({ error: "order required" }, { status: 400 });
  }

  const db = getDb();
  const existing = db
    .select({ bookId: collectionBooks.bookId })
    .from(collectionBooks)
    .where(eq(collectionBooks.collectionId, id))
    .all();
  const validSet = new Set(existing.map((r) => r.bookId));

  let seq = 0;
  for (const bookId of order) {
    if (!validSet.has(bookId)) continue;
    db.update(collectionBooks)
      .set({ seq: seq++ })
      .where(
        and(
          eq(collectionBooks.collectionId, id),
          eq(collectionBooks.bookId, bookId),
        ),
      )
      .run();
  }
  db.update(collections)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(collections.id, id))
    .run();

  return NextResponse.json({ success: true });
}
