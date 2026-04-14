import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { paragraphs, translations } from "@/lib/db/schema";
import { eq, count, and } from "drizzle-orm";
import { loadChapterForRead } from "@/lib/access";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  const { chapter } = await loadChapterForRead(id);
  if (!chapter) {
    return NextResponse.json({ error: "Chapter not found" }, { status: 404 });
  }

  const totalParas = db
    .select({ count: count() })
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, id))
    .get();

  const doneTranslations = db
    .select({ count: count() })
    .from(translations)
    .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
    .where(and(eq(paragraphs.chapterId, id), eq(translations.status, "done")))
    .get();

  const failedTranslations = db
    .select({ count: count() })
    .from(translations)
    .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
    .where(and(eq(paragraphs.chapterId, id), eq(translations.status, "failed")))
    .get();

  return NextResponse.json({
    chapterStatus: chapter.status,
    totalParagraphs: totalParas?.count || 0,
    doneTranslations: doneTranslations?.count || 0,
    failedTranslations: failedTranslations?.count || 0,
  });
}
