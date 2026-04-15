import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, chapters } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { loadBookForRead, loadBookForWrite } from "@/lib/access";
import { getUploadsStorage, getCoversStorage } from "@/lib/storage";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  const { book } = await loadBookForRead(id);
  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const chapterList = await db
    .select({
      id: chapters.id,
      index: chapters.index,
      title: chapters.title,
      status: chapters.status,
    })
    .from(chapters)
    .where(eq(chapters.bookId, id))
    .orderBy(chapters.index)
    .all();

  return NextResponse.json({ ...book, chapters: chapterList });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  const result = await loadBookForWrite(id);
  if (!result.book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }
  if (result.forbidden) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const { book } = result;

  // Best-effort: storage.delete already tolerates a missing object, so
  // we can call it unconditionally without a try/catch.
  await getUploadsStorage().delete(book.filePath);
  if (book.coverPath) {
    await getCoversStorage().delete(book.coverPath);
  }

  // Cascade delete handles chapters, paragraphs, translations
  await db.delete(books).where(eq(books.id, id)).run();

  return NextResponse.json({ success: true });
}
