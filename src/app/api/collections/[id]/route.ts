import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { collections } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { loadCollectionForView, loadOwnedCollection } from "@/lib/collections";
import { loadCollectionBooksWithProgress } from "@/lib/library/collection-queries";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  const col = await loadCollectionForView(id, {
    id: user.id,
    isAdmin: user.isAdmin,
  });
  if (!col) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const db = getDb();
  const decorated = await loadCollectionBooksWithProgress(db, id, {
    includePrivateMembers: col.userId === user.id || user.isAdmin,
  });

  return NextResponse.json({
    id: col.id,
    name: col.name,
    userId: col.userId,
    visibility: col.visibility,
    createdAt: col.createdAt,
    updatedAt: col.updatedAt,
    isReadOnly: col.userId !== user.id, // admin backdoor view-only flag
    books: decorated,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  const col = await loadOwnedCollection(id, {
    id: user.id,
    isAdmin: user.isAdmin,
  });
  if (!col) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });
  if (name.length > 120) return NextResponse.json({ error: "Name too long" }, { status: 400 });

  const db = getDb();
  await db
    .update(collections)
    .set({ name, updatedAt: new Date().toISOString() })
    .where(eq(collections.id, id))
    .run();

  return NextResponse.json({ id, name });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  const col = await loadOwnedCollection(id, {
    id: user.id,
    isAdmin: user.isAdmin,
  });
  if (!col) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const db = getDb();
  await db.delete(collections).where(eq(collections.id, id)).run();
  // ON DELETE SET NULL on books.collection_id returns members to top level.
  return NextResponse.json({ success: true });
}
