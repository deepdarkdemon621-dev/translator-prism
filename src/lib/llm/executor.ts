import { getDb } from "@/lib/db";
import { books, chapters, paragraphs, translations } from "@/lib/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { createProvider } from "@/lib/llm/factory";
import { loadLLMSettings } from "@/lib/llm/settings";
import type { LLMProvider } from "@/lib/llm/types";
import { checkChapterDone } from "@/lib/chapter-status";

let _provider: LLMProvider | null = null;
function provider(): LLMProvider {
  if (!_provider) {
    const s = loadLLMSettings();
    _provider = createProvider(s.provider, s.apiKey);
  }
  return _provider;
}

/** Translate a single claimed row. Caller has already set its status to
 *  'processing' via an atomic UPDATE. */
export async function runTranslation(translationId: string): Promise<void> {
  const db = getDb();

  const row = await db
    .select({
      id: translations.id,
      lang: translations.lang,
      status: translations.status,
      paragraphId: paragraphs.id,
      sourceText: paragraphs.sourceText,
      chapterId: paragraphs.chapterId,
      sourceLang: books.sourceLang,
    })
    .from(translations)
    .innerJoin(paragraphs, eq(paragraphs.id, translations.paragraphId))
    .innerJoin(chapters, eq(chapters.id, paragraphs.chapterId))
    .innerJoin(books, eq(books.id, chapters.bookId))
    .where(eq(translations.id, translationId))
    .get();

  if (!row) return;
  if (row.status === "cancelled") return;

  try {
    const result = await provider().translate(
      row.sourceText,
      row.sourceLang,
      row.lang,
    );
    await db
      .update(translations)
      .set({
        text: result.text,
        status: "done",
        model: result.model,
        tokensUsed: result.tokensUsed,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(translations.id, translationId), ne(translations.status, "cancelled")));
    await checkChapterDone(row.chapterId);
  } catch (err) {
    await db
      .update(translations)
      .set({
        status: "failed",
        errorMessage: (err as Error).message,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(translations.id, translationId), ne(translations.status, "cancelled")));
    await checkChapterDone(row.chapterId);
  }
}
