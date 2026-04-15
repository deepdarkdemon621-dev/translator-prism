import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { translations, chapters } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { loadParagraphForWrite } from "@/lib/access";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  // Retry is a write: only the book's owner (or admin) can re-run jobs.
  const access = await loadParagraphForWrite(id);
  if (!access.paragraph) {
    return NextResponse.json({ error: "Paragraph not found" }, { status: 404 });
  }
  if (access.forbidden) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const { paragraph: para } = access;

  const failedTranslations = (
    await db
      .select()
      .from(translations)
      .where(eq(translations.paragraphId, id))
      .all()
  ).filter((t) => t.status === "failed");

  if (failedTranslations.length === 0) {
    return NextResponse.json({ error: "No failed translations" }, { status: 400 });
  }

  // Flip the chapter back out of its terminal state so the reader poll loop
  // resumes. checkChapterDone (called by the worker on completion) will move
  // it to "done" or "error" again once everything settles.
  await db
    .update(chapters)
    .set({ status: "translating", updatedAt: new Date().toISOString() })
    .where(eq(chapters.id, para.chapterId))
    .run();

  // Pure-DB enqueue: flip failed rows to 'pending' and the worker poller
  // picks them up. No in-process queue, no callbacks — the worker handles
  // result persistence and chapter-done bookkeeping.
  for (const t of failedTranslations) {
    await db
      .update(translations)
      .set({
        status: "pending",
        errorMessage: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(translations.id, t.id))
      .run();
  }

  return NextResponse.json({ retried: failedTranslations.length });
}
