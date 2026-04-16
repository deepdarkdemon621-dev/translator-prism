import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { paragraphs, translations } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
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

  const paras = await db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, id))
    .orderBy(paragraphs.seq)
    .all();

  // Batch-fetch translations for every paragraph in one query instead of
  // N sequential selects. For a 200-paragraph chapter this cuts DB
  // roundtrips from 201 to 2 and dominates the reader's chapter-open time.
  const paraIds = paras.map((p) => p.id);
  const allTrans = paraIds.length > 0
    ? await db
        .select()
        .from(translations)
        .where(inArray(translations.paragraphId, paraIds))
        .all()
    : [];

  type TransEntry = { text: string | null; status: string; errorMessage: string | null };
  const transByPara = new Map<string, Record<string, TransEntry>>();
  for (const t of allTrans) {
    let bucket = transByPara.get(t.paragraphId);
    if (!bucket) {
      bucket = {};
      transByPara.set(t.paragraphId, bucket);
    }
    bucket[t.lang] = {
      text: t.text,
      status: t.status,
      errorMessage: t.errorMessage,
    };
  }

  const parasWithTranslations = paras.map((p) => ({
    ...p,
    translations: transByPara.get(p.id) ?? {},
  }));

  return NextResponse.json({
    ...chapter,
    paragraphs: parasWithTranslations,
  });
}
