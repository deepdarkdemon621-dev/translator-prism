import { getDb } from "@/lib/db";
import { books, chapters, paragraphs, translations } from "@/lib/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { createProvider } from "@/lib/llm/factory";
import { loadLLMSettings } from "@/lib/llm/settings";
import { classifyLLMError, formatErrorMessage } from "@/lib/llm/errors";
import type { LLMProvider } from "@/lib/llm/types";
import { checkChapterDone } from "@/lib/chapter-status";

// Signature-keyed cache so the worker picks up /settings UI changes
// without a PM2 restart. Each translation reads settings, derives a
// signature, and reuses the provider instance only while it matches.
// DB read per translation is ~2ms against Turso — negligible next to an
// LLM call that takes seconds.
interface ProviderCache {
  signature: string;
  provider: LLMProvider;
  fallbackReason?: string;
}
let _cache: ProviderCache | null = null;
let _lastLoggedFallback: string | null = null;

async function getProvider(): Promise<LLMProvider> {
  const s = await loadLLMSettings();
  // Signature covers everything createProvider branches on. apiKey folded
  // to a boolean so rotating a key also invalidates the cache (different
  // strings → same shape but we want a fresh client with the new key).
  const sig = `${s.provider}|${s.apiKey ? hashKey(s.apiKey) : ""}|${s.model ?? ""}`;
  if (_cache?.signature === sig) return _cache.provider;
  const provider = createProvider(s.provider, s.apiKey);
  _cache = { signature: sig, provider, fallbackReason: s.fallbackReason };
  if (s.fallbackReason && s.fallbackReason !== _lastLoggedFallback) {
    console.log(`[executor] ${s.fallbackReason}`);
    _lastLoggedFallback = s.fallbackReason;
  }
  return provider;
}

// Non-cryptographic — we only need "did the key change" signal for cache
// invalidation, not secrecy. Keeps sensitive keys out of the in-memory
// signature string.
function hashKey(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return h.toString(36);
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
    const provider = await getProvider();
    const result = await provider.translate(
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
    // Classify before writing so the UI can parse [code] to decide
    // whether to show the quota banner. See src/lib/llm/errors.ts.
    const classified = classifyLLMError(err);
    await db
      .update(translations)
      .set({
        status: "failed",
        errorMessage: formatErrorMessage(classified),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(translations.id, translationId), ne(translations.status, "cancelled")));
    try {
      await checkChapterDone(row.chapterId);
    } catch (chkErr) {
      console.error("[executor] checkChapterDone after failure threw:", chkErr);
    }
  }
}
