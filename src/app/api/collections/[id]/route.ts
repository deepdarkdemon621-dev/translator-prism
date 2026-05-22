import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, chapters, collections, paragraphs, translations } from "@/lib/db/schema";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { loadCollectionForView, loadOwnedCollection } from "@/lib/collections";

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

  // Book visibility inside this collection:
  //   - owner or admin: see every book
  //   - other user viewing admin's public collection: only public books
  let bookFilter = eq(books.collectionId, id);
  const isOwnerOrAdmin = col.userId === user.id || user.isAdmin;
  if (!isOwnerOrAdmin) {
    bookFilter = and(bookFilter, eq(books.visibility, "public"))!;
  }

  const rows = await db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      sourceLang: books.sourceLang,
      coverPath: books.coverPath,
      totalChapters: books.totalChapters,
      status: books.status,
      userId: books.userId,
      seq: books.collectionSeq,
    })
    .from(books)
    .where(bookFilter)
    .orderBy(asc(books.collectionSeq), asc(books.createdAt))
    .all();

  const decorated = await Promise.all(
    rows.map(async (b) => {
      const doneRow = await db
        .select({
          n: sql<number>`SUM(CASE WHEN ${chapters.status} = 'done' OR (
            NOT EXISTS (
              SELECT 1 FROM paragraphs p_text
              WHERE p_text.chapter_id = ${chapters.id} AND p_text.kind = 'text'
            )
            AND EXISTS (
              SELECT 1 FROM paragraphs p_image
              WHERE p_image.chapter_id = ${chapters.id} AND p_image.kind = 'image'
            )
          ) THEN 1 ELSE 0 END)`,
        })
        .from(chapters)
        .where(eq(chapters.bookId, b.id))
        .all();

      const paraIds = (
        await db
          .select({ id: paragraphs.id })
          .from(paragraphs)
          .innerJoin(chapters, eq(chapters.id, paragraphs.chapterId))
          .where(eq(chapters.bookId, b.id))
          .all()
      ).map((p) => p.id);

      const pendingTranslations = paraIds.length
        ? (
            await db
              .select({ n: count() })
              .from(translations)
              .where(
                and(
                  inArray(translations.paragraphId, paraIds),
                  inArray(translations.status, ["pending", "processing"]),
                ),
              )
              .all()
          )[0]?.n || 0
        : 0;

      return {
        ...b,
        translatedChapters: doneRow[0]?.n || 0,
        pendingTranslations,
      };
    }),
  );

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
