import { getDb } from "@/lib/db";
import { books, chapters, paragraphs, translations } from "@/lib/db/schema";
import { and, eq, inArray, ne } from "drizzle-orm";
import { buildProviderFromEnv } from "@/lib/llm/factory";
import { loadLLMSettings } from "@/lib/llm/settings";
import {
  classifyLLMError,
  formatErrorMessage,
  type ClassifiedLLMError,
} from "@/lib/llm/errors";
import { ProviderChainError } from "@/lib/llm/provider-chain";
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
  const sig = [
    `chain:${process.env.TRANSLATION_PROVIDER_CHAIN ?? ""}`,
    `cli:${getCliConfigSignature()}`,
    s.provider,
    s.apiKey ? hashKey(s.apiKey) : "",
    s.model ?? "",
  ].join("|");
  if (_cache?.signature === sig) return _cache.provider;
  const provider = buildProviderFromEnv(s.provider, s.apiKey);
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

function getCliConfigSignature(): string {
  return [
    process.env.CLAUDE_CODE_ENABLED ?? "",
    process.env.CLAUDE_CODE_MODEL ?? "",
    process.env.CLAUDE_CODE_BARE ?? "",
    process.env.CLAUDE_CODE_MAX_BUDGET_USD ?? "",
    process.env.CLAUDE_CODE_ALLOWED_WEEKLY_WINDOW ?? "",
    process.env.CLAUDE_CODE_WINDOW_TZ ?? "",
    process.env.CLAUDE_CODE_EXCLUSIVE_WITHIN_WINDOW ?? "",
    process.env.CLAUDE_CODE_EXCLUSIVE_RETRY_DELAY_MS ?? "",
    process.env.CODEX_CLI_ENABLED ?? "",
    process.env.CODEX_CLI_MODEL ?? "",
    process.env.CODEX_CLI_ALLOW_BYPASS ?? "",
  ].join("|");
}

/** Provider instance for the worker's claimed-batch pipeline. Shares the
 *  settings-signature cache above, so /settings changes apply without a
 *  worker restart. */
export async function getConfiguredProvider(): Promise<LLMProvider> {
  return getProvider();
}

export function classifyTranslationFailure(err: unknown): ClassifiedLLMError {
  if (err instanceof ProviderChainError) {
    return {
      code: err.finalCode,
      friendly: "All providers failed",
      raw: err.message.slice(0, 500),
    };
  }

  return classifyLLMError(err);
}

export function getResultProviderName(model: string | null, providerName: string): string {
  if (!model) return providerName;
  const separator = model.indexOf(":");
  return separator > 0 ? model.slice(0, separator) : providerName;
}

/** Translate a single claimed row. Caller has already set its status to
 *  'processing' via an atomic UPDATE. */
export type TranslationRunResult = "done" | "failed" | "skipped";

export async function runTranslations(
  translationIds: string[],
): Promise<TranslationRunResult[]> {
  if (translationIds.length === 0) return [];
  if (translationIds.length === 1) {
    return [await runTranslation(translationIds[0])];
  }

  const db = getDb();
  const rows = await db
    .select({
      id: translations.id,
      lang: translations.lang,
      status: translations.status,
      paragraphId: paragraphs.id,
      seq: paragraphs.seq,
      sourceText: paragraphs.sourceText,
      chapterId: paragraphs.chapterId,
      chapterTitle: chapters.title,
      bookTitle: books.title,
      sourceLang: books.sourceLang,
    })
    .from(translations)
    .innerJoin(paragraphs, eq(paragraphs.id, translations.paragraphId))
    .innerJoin(chapters, eq(chapters.id, paragraphs.chapterId))
    .innerJoin(books, eq(books.id, chapters.bookId))
    .where(inArray(translations.id, translationIds));

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const statuses = new Map<string, TranslationRunResult>();
  const runnableRows = [];
  for (const id of translationIds) {
    const row = rowsById.get(id);
    if (!row || row.status === "cancelled") {
      statuses.set(id, "skipped");
      continue;
    }
    runnableRows.push(row);
  }
  if (runnableRows.length === 0) {
    return translationIds.map((id) => statuses.get(id) ?? "skipped");
  }

  let activeProviderName: string | null = null;
  const provider = await getProvider().catch(() => null);
  if (!provider || !provider.translateBatch) {
    return Promise.all(translationIds.map((id) => runTranslation(id)));
  }
  activeProviderName = provider.name;

  // The chapter batch contract allows one chapter and one target language
  // per model call, so a mixed claim fans out into one call per group.
  const groups = new Map<string, typeof runnableRows>();
  for (const row of runnableRows) {
    const key = `${row.chapterId}|${row.lang}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.seq - b.seq);
    try {
      const results = await provider.translateBatch({
        bookTitle: sorted[0].bookTitle,
        chapterTitle: sorted[0].chapterTitle,
        sourceLang: sorted[0].sourceLang,
        targetLang: sorted[0].lang,
        items: sorted.map((row) => ({
          id: row.id,
          seq: row.seq,
          text: row.sourceText,
        })),
      });
      const resultById = new Map(results.map((result) => [result.id, result]));
      const now = new Date().toISOString();

      for (const row of sorted) {
        const result = resultById.get(row.id);
        if (!result) {
          const updated = await db
            .update(translations)
            .set({
              status: "failed",
              errorMessage: "[invalid_output] missing from batch output",
              lastProvider: activeProviderName,
              lastErrorCode: "invalid_output",
              updatedAt: now,
            })
            .where(and(eq(translations.id, row.id), ne(translations.status, "cancelled")))
            .returning({ id: translations.id })
            .get();
          statuses.set(row.id, updated ? "failed" : "skipped");
          await checkChapterDone(row.chapterId);
          continue;
        }
        const updated = await db
          .update(translations)
          .set({
            text: result.text,
            status: "done",
            model: result.model,
            tokensUsed: result.tokensUsed,
            errorMessage: null,
            lastProvider: getResultProviderName(result.model, provider.name),
            lastErrorCode: null,
            updatedAt: now,
          })
          .where(and(eq(translations.id, row.id), ne(translations.status, "cancelled")))
          .returning({ id: translations.id })
          .get();
        statuses.set(row.id, updated ? "done" : "skipped");
        await checkChapterDone(row.chapterId);
      }
    } catch (err) {
      const classified = classifyTranslationFailure(err);
      const chainError = err instanceof ProviderChainError ? err : null;
      const now = new Date().toISOString();
      for (const row of group) {
        const updated = await db
          .update(translations)
          .set({
            status: "failed",
            errorMessage: formatErrorMessage(classified),
            lastProvider: chainError?.finalProvider ?? activeProviderName,
            lastErrorCode: classified.code,
            updatedAt: now,
          })
          .where(and(eq(translations.id, row.id), ne(translations.status, "cancelled")))
          .returning({ id: translations.id })
          .get();
        statuses.set(row.id, updated ? "failed" : "skipped");
        try {
          await checkChapterDone(row.chapterId);
        } catch (chkErr) {
          console.error("[executor] checkChapterDone after batch failure threw:", chkErr);
        }
      }
    }
  }

  return translationIds.map((id) => statuses.get(id) ?? "skipped");
}

export async function runTranslation(translationId: string): Promise<TranslationRunResult> {
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

  if (!row) return "skipped";
  if (row.status === "cancelled") return "skipped";

  let activeProviderName: string | null = null;

  try {
    const provider = await getProvider();
    activeProviderName = provider.name;
    const result = await provider.translate(
      row.sourceText,
      row.sourceLang,
      row.lang,
    );
    const updated = await db
      .update(translations)
      .set({
        text: result.text,
        status: "done",
        model: result.model,
        tokensUsed: result.tokensUsed,
        errorMessage: null,
        lastProvider: getResultProviderName(result.model, provider.name),
        lastErrorCode: null,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(translations.id, translationId), ne(translations.status, "cancelled")))
      .returning({ id: translations.id })
      .get();
    if (!updated) return "skipped";
    await checkChapterDone(row.chapterId);
    return "done";
  } catch (err) {
    // Classify before writing so the UI can parse [code] to decide
    // whether to show the quota banner. See src/lib/llm/errors.ts.
    const classified = classifyTranslationFailure(err);
    const chainError = err instanceof ProviderChainError ? err : null;
    const updated = await db
      .update(translations)
      .set({
        status: "failed",
        errorMessage: formatErrorMessage(classified),
        lastProvider: chainError?.finalProvider ?? activeProviderName,
        lastErrorCode: classified.code,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(translations.id, translationId), ne(translations.status, "cancelled")))
      .returning({ id: translations.id })
      .get();
    if (!updated) return "skipped";
    try {
      await checkChapterDone(row.chapterId);
    } catch (chkErr) {
      console.error("[executor] checkChapterDone after failure threw:", chkErr);
    }
    return "failed";
  }
}
