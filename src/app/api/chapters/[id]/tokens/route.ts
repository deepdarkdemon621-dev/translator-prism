import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, paragraphs } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { loadChapterForRead } from "@/lib/access";
import { tokenizeContentWords } from "@/lib/learning/tokenize";

/**
 * Content-word token spans for every text paragraph of a chapter, used by
 * the immersive reader to highlight unknown words. Japanese-only for now —
 * other source languages return an empty map and the reader falls back to
 * plain rendering.
 *
 * Tokenization is deterministic, so the response is privately cacheable;
 * the client also memoizes per chapter.
 */
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

  const book = await db
    .select({ sourceLang: books.sourceLang })
    .from(books)
    .where(eq(books.id, chapter.bookId))
    .get();
  if (!book || book.sourceLang !== "ja") {
    return NextResponse.json(
      { tokens: {} },
      { headers: { "Cache-Control": "private, max-age=3600" } },
    );
  }

  const paras = await db
    .select({ id: paragraphs.id, sourceText: paragraphs.sourceText })
    .from(paragraphs)
    .where(and(eq(paragraphs.chapterId, id), eq(paragraphs.kind, "text")))
    .orderBy(paragraphs.seq)
    .all();

  // Compact wire format: [start, end, lemma] tuples per paragraph.
  const tokens: Record<string, [number, number, string][]> = {};
  for (const p of paras) {
    const spans = await tokenizeContentWords(p.sourceText);
    tokens[p.id] = spans.map((s) => [s.start, s.end, s.lemma]);
  }

  return NextResponse.json(
    { tokens },
    { headers: { "Cache-Control": "private, max-age=3600" } },
  );
}
