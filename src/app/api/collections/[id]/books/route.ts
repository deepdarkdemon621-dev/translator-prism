import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, collections } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { loadOwnedCollection } from "@/lib/collections";

/**
 * PUT: reorder books inside a collection. Body: { order: bookId[] }.
 * Each book's collection_seq is set to its index in the array. Books
 * in the payload that aren't members of this collection are silently
 * dropped rather than moved in. Use POST /api/books/[id]/move to add.
 *
 * Owner-only. Admin's view-only backdoor does not extend to reorder.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  const col = loadOwnedCollection(id, { id: user.id, isAdmin: user.isAdmin });
  if (!col) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const order: string[] = Array.isArray(body.order) ? body.order : [];
  if (order.length === 0) {
    return NextResponse.json({ error: "order required" }, { status: 400 });
  }

  const db = getDb();
  const members = db
    .select({ id: books.id })
    .from(books)
    .where(eq(books.collectionId, id))
    .all();
  const valid = new Set(members.map((m) => m.id));

  let seq = 0;
  for (const bookId of order) {
    if (!valid.has(bookId)) continue;
    db.update(books)
      .set({ collectionSeq: seq++, updatedAt: new Date().toISOString() })
      .where(eq(books.id, bookId))
      .run();
  }
  db.update(collections)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(collections.id, id))
    .run();

  return NextResponse.json({ success: true });
}
