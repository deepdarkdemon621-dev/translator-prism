import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { collectionBooks, collections } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { loadOwnedCollection } from "@/lib/collections";

/**
 * DELETE: remove a book from this collection. The underlying book is
 * untouched. If we just evicted the smallest-seq book, the collection's
 * derived cover silently shifts to whatever is now first.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; bookId: string }> },
) {
  const { id, bookId } = await params;
  const { collection } = await loadOwnedCollection(id);
  if (!collection) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const db = getDb();
  db.delete(collectionBooks)
    .where(
      and(
        eq(collectionBooks.collectionId, id),
        eq(collectionBooks.bookId, bookId),
      ),
    )
    .run();
  db.update(collections)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(collections.id, id))
    .run();

  return NextResponse.json({ success: true });
}
