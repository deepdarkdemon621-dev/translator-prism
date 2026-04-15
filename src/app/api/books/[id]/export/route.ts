import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { chapters, paragraphs, translations } from "@/lib/db/schema";
import { asc, eq, inArray } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { loadBookForRead } from "@/lib/access";
import { getCoversStorage } from "@/lib/storage";

/**
 * Export a fully-translated book as a portable JSON blob.
 *
 * Purpose: the intended deployment is cloud app + local LLM. The admin
 * translates books offline against Ollama, exports them with this route,
 * then uploads to the cloud via /api/books/import. The cloud copy lands
 * as a `public` showcase book so normal users can read it without
 * re-running the paid API.
 *
 * Admin-only. The export contains the full source HTML + every
 * translation, so leaking arbitrary users' books would be a privacy leak
 * even if the book were public showcase today.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const { book } = await loadBookForRead(id);
  if (!book) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const db = getDb();
  const chRows = await db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, id))
    .orderBy(asc(chapters.index))
    .all();

  const chapterIds = chRows.map((c) => c.id);
  const paraRows = chapterIds.length
    ? await db
        .select()
        .from(paragraphs)
        .where(inArray(paragraphs.chapterId, chapterIds))
        .orderBy(asc(paragraphs.seq))
        .all()
    : [];
  const paraIds = paraRows.map((p) => p.id);
  const transRows = paraIds.length
    ? await db
        .select()
        .from(translations)
        .where(inArray(translations.paragraphId, paraIds))
        .all()
    : [];

  // Cover as base64 if present. We embed it so the import side doesn't
  // need a separate upload step.
  let cover: { ext: string; base64: string } | null = null;
  if (book.coverPath) {
    try {
      const bytes = await getCoversStorage().get(book.coverPath);
      const extMatch = book.coverPath.toLowerCase().match(/\.([a-z0-9]+)$/);
      cover = {
        ext: extMatch?.[1] || "jpg",
        base64: bytes.toString("base64"),
      };
    } catch {
      // Missing cover file is non-fatal; export proceeds without it.
    }
  }

  const transByPara = new Map<string, typeof transRows>();
  for (const t of transRows) {
    const arr = transByPara.get(t.paragraphId) ?? [];
    arr.push(t);
    transByPara.set(t.paragraphId, arr);
  }
  const parasByChapter = new Map<string, typeof paraRows>();
  for (const p of paraRows) {
    const arr = parasByChapter.get(p.chapterId) ?? [];
    arr.push(p);
    parasByChapter.set(p.chapterId, arr);
  }

  const payload = {
    // Version the export so the import side can reject formats it doesn't
    // understand when we evolve this later.
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    book: {
      title: book.title,
      author: book.author,
      sourceLang: book.sourceLang,
    },
    cover,
    chapters: chRows.map((c) => ({
      index: c.index,
      title: c.title,
      sourceHtml: c.sourceHtml,
      status: c.status,
      paragraphs: (parasByChapter.get(c.id) ?? []).map((p) => ({
        seq: p.seq,
        sourceText: p.sourceText,
        sourceMarkup: p.sourceMarkup,
        translations: (transByPara.get(p.id) ?? []).map((t) => ({
          lang: t.lang,
          text: t.text,
          status: t.status,
          model: t.model,
          tokensUsed: t.tokensUsed,
        })),
      })),
    })),
  };

  // Filename friendly slug — alphanumeric + dashes, truncated.
  const slug =
    book.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "book";

  return new NextResponse(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${slug}-${id}.prism.json"`,
    },
  });
}
