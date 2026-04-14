import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { paragraphs, translations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
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

  const paras = db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, id))
    .orderBy(paragraphs.seq)
    .all();

  const parasWithTranslations = paras.map((p) => {
    const trans = db
      .select()
      .from(translations)
      .where(eq(translations.paragraphId, p.id))
      .all();

    return {
      ...p,
      translations: trans.reduce(
        (acc, t) => {
          acc[t.lang] = {
            text: t.text,
            status: t.status,
            errorMessage: t.errorMessage,
          };
          return acc;
        },
        {} as Record<
          string,
          { text: string | null; status: string; errorMessage: string | null }
        >,
      ),
    };
  });

  return NextResponse.json({
    ...chapter,
    paragraphs: parasWithTranslations,
  });
}
