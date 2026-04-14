import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { readingProgress } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { loadBookForRead } from "@/lib/access";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params;
  const db = getDb();

  // Reading progress is per-user: two readers on the same showcase book
  // keep their own positions. Non-accessible book → 404 so we don't leak.
  const { user, book } = await loadBookForRead(bookId);
  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const progress = db
    .select()
    .from(readingProgress)
    .where(
      and(
        eq(readingProgress.bookId, bookId),
        eq(readingProgress.userId, user.id),
      ),
    )
    .get();

  return NextResponse.json(progress || { chapterIndex: 0, scrollPosition: 0 });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params;
  const body = await request.json();
  const db = getDb();

  const { user, book } = await loadBookForRead(bookId);
  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const existing = db
    .select()
    .from(readingProgress)
    .where(
      and(
        eq(readingProgress.bookId, bookId),
        eq(readingProgress.userId, user.id),
      ),
    )
    .get();

  if (existing) {
    db.update(readingProgress)
      .set({
        chapterIndex: body.chapterIndex ?? existing.chapterIndex,
        scrollPosition: body.scrollPosition ?? existing.scrollPosition,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(readingProgress.id, existing.id))
      .run();
  } else {
    db.insert(readingProgress)
      .values({
        id: randomUUID(),
        bookId,
        userId: user.id,
        chapterIndex: body.chapterIndex ?? 0,
        scrollPosition: body.scrollPosition ?? 0,
      })
      .run();
  }

  return NextResponse.json({ success: true });
}
