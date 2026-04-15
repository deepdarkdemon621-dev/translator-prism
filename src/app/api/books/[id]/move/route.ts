import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { moveBookToCollection } from "@/lib/collections";

/**
 * Move a book into a collection, or out to top level. Body:
 *   { collectionId: string | null }
 *
 * Only the book's owner can call this, and only into their own
 * collections. Admin is not special here — the view-only backdoor in
 * loadCollectionForView does not extend to writes. 403 covers both
 * "not your book" and "not your collection".
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  const body = await request.json().catch(() => ({}));

  let targetCollectionId: string | null;
  if (body.collectionId === null) {
    targetCollectionId = null;
  } else if (typeof body.collectionId === "string") {
    targetCollectionId = body.collectionId;
  } else {
    return NextResponse.json(
      { error: "collectionId must be string or null" },
      { status: 400 },
    );
  }

  try {
    await moveBookToCollection({
      bookId: id,
      targetCollectionId,
      actingUserId: user.id,
      actingIsAdmin: user.isAdmin,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (/not found/.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    return NextResponse.json({ error: msg }, { status: 403 });
  }

  return NextResponse.json({ success: true });
}
