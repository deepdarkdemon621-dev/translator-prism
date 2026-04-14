import { NextRequest, NextResponse } from "next/server";
import { loadChapterForWrite } from "@/lib/access";
import { hasChapterAccess } from "@/lib/billing";
import { enqueueChapterTranslations } from "@/lib/translate/enqueue";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Translate is a write: only the owner or an admin can trigger it, even
  // for public showcase books (non-owners reading a showcase book never
  // need to start jobs — those are pre-translated).
  const access = await loadChapterForWrite(id);
  if (!access.chapter) {
    return NextResponse.json({ error: "Chapter not found" }, { status: 404 });
  }
  if (access.forbidden) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const { user, book } = access;

  // Paywall: private books require a purchased chapter_access row (admin
  // and public-showcase books are waved through inside hasChapterAccess).
  if (!hasChapterAccess(user, id)) {
    return NextResponse.json(
      { error: "Chapter locked — purchase required", code: "chapter_locked" },
      { status: 402 },
    );
  }

  const result = await enqueueChapterTranslations(id, book.sourceLang);

  return NextResponse.json({
    queued: result.queued,
    totalParagraphs: result.totalParagraphs,
  });
}
