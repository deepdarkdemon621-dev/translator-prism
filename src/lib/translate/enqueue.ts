import { getDb } from "@/lib/db";
import { chapters, paragraphs, translations } from "@/lib/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { getTranslationQueue } from "@/lib/queue/translation-queue";
import { checkChapterDone } from "@/lib/chapter-status";
import { randomUUID } from "crypto";

const TARGET_LANGS: Record<string, string[]> = {
  ja: ["zh", "en"],
  zh: ["ja", "en"],
  en: ["ja", "zh"],
};

export interface EnqueueResult {
  /** Rows newly added to (or re-armed in) the queue. */
  queued: number;
  /** Paragraphs already fully translated — skipped with no queue work. */
  skippedDone: number;
  totalParagraphs: number;
  /** Sum of source characters for translations we actually queued. Caller
   * multiplies by language count itself if needed — this is paragraph
   * source length × number of queued langs for that paragraph. */
  queuedChars: number;
}

/**
 * Shared enqueue logic used by both the single-chapter translate route and
 * the batch translate-all routes. Caller is responsible for authz / paywall
 * — this function trusts that it may run.
 *
 * Behaviour mirrors the original per-chapter route: re-parses paragraphs
 * from sourceHtml if the paragraphs table is empty for this chapter, then
 * for each of the two non-source langs either inserts a pending row or
 * re-arms an existing non-done row, and marks the chapter "translating".
 */
export async function enqueueChapterTranslations(
  chapterId: string,
  sourceLang: string,
): Promise<EnqueueResult> {
  const db = getDb();

  let paras = await db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, chapterId))
    .orderBy(paragraphs.seq)
    .all();

  if (paras.length === 0) {
    const chapter = await db
      .select()
      .from(chapters)
      .where(eq(chapters.id, chapterId))
      .get();
    if (!chapter) {
      return { queued: 0, skippedDone: 0, totalParagraphs: 0, queuedChars: 0 };
    }

    // Lazy-import cheerio so we don't drag it in until we actually need to
    // parse — same pattern as the single-chapter translate route.
    const $ = await import("cheerio").then((m) =>
      m.load(chapter.sourceHtml, { xmlMode: true }),
    );
    const extracted: { text: string; markup: string }[] = [];
    $("body p, p").each((_, el) => {
      const text = $(el).text().trim();
      if (text.length === 0) return;
      const markup = $.html(el) || "";
      extracted.push({ text, markup });
    });

    for (let j = 0; j < extracted.length; j++) {
      await db
        .insert(paragraphs)
        .values({
          id: randomUUID(),
          chapterId,
          seq: j,
          sourceText: extracted[j].text,
          sourceMarkup: extracted[j].markup,
        })
        .run();
    }

    paras = await db
      .select()
      .from(paragraphs)
      .where(eq(paragraphs.chapterId, chapterId))
      .orderBy(paragraphs.seq)
      .all();
  }

  const targetLangs = TARGET_LANGS[sourceLang] || ["zh", "en"];
  const queue = getTranslationQueue();

  let queued = 0;
  let skippedDone = 0;
  let queuedChars = 0;

  for (const para of paras) {
    const existingForPara = await db
      .select()
      .from(translations)
      .where(eq(translations.paragraphId, para.id))
      .all();

    for (const lang of targetLangs) {
      const existing = existingForPara.find((t) => t.lang === lang);
      if (existing && existing.status === "done") {
        skippedDone++;
        continue;
      }

      const translationId = existing?.id || randomUUID();
      if (!existing) {
        await db
          .insert(translations)
          .values({
            id: translationId,
            paragraphId: para.id,
            lang,
            status: "pending",
          })
          .run();
      } else {
        await db
          .update(translations)
          .set({
            status: "pending",
            errorMessage: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(translations.id, translationId))
          .run();
      }

      queue.add({
        translationId,
        text: para.sourceText,
        fromLang: sourceLang,
        toLang: lang,
        // Peek DB just before running: if the row was cancelled while
        // waiting, skip the provider call entirely. shouldRun must return
        // synchronously — we optimistically return true and let the
        // onComplete handler re-check before writing. The queue (Task 10)
        // is being replaced by a worker, so this bridge is short-lived.
        shouldRun: () => true,
        onComplete: (result) => {
          void (async () => {
            // WHERE status != 'cancelled' guards against a race where the
            // LLM call completed after the user clicked Cancel — we don't
            // want to overwrite cancelled rows back to done.
            await getDb()
              .update(translations)
              .set({
                text: result.text,
                status: "done",
                model: result.model,
                tokensUsed: result.tokensUsed,
                updatedAt: new Date().toISOString(),
              })
              .where(
                and(
                  eq(translations.id, translationId),
                  ne(translations.status, "cancelled"),
                ),
              )
              .run();
            await checkChapterDone(chapterId);
          })().catch((err) => {
            console.error(
              "[enqueue:onComplete] failed to persist translation result:",
              err,
            );
          });
        },
        onError: (error) => {
          void (async () => {
            await getDb()
              .update(translations)
              .set({
                status: "failed",
                errorMessage: error.message,
                updatedAt: new Date().toISOString(),
              })
              .where(
                and(
                  eq(translations.id, translationId),
                  ne(translations.status, "cancelled"),
                ),
              )
              .run();
            await checkChapterDone(chapterId);
          })().catch((err) => {
            console.error(
              "[enqueue:onError] failed to persist translation failure:",
              err,
            );
          });
        },
      });

      queued++;
      queuedChars += para.sourceText.length;
    }
  }

  if (queued > 0) {
    await db
      .update(chapters)
      .set({ status: "translating", updatedAt: new Date().toISOString() })
      .where(eq(chapters.id, chapterId))
      .run();
  }

  return {
    queued,
    skippedDone,
    totalParagraphs: paras.length,
    queuedChars,
  };
}

/**
 * Estimate pending work for a chapter without queueing anything. Used by
 * the batch translate-all cost gate to compute total estimated tokens
 * before the caller confirms.
 *
 * Heuristic: each non-done translation costs ~1 input token per source
 * character (JA/ZH CJK roughly 1:1 with BPE) plus ~1 output token, so
 * total tokens ≈ 2 × queuedChars. Rough but round enough for a warning.
 */
export async function estimateChapterWork(
  chapterId: string,
  sourceLang: string,
): Promise<{ queuedChars: number; queuedTranslations: number }> {
  const db = getDb();
  const paras = await db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, chapterId))
    .all();

  const targetLangs = TARGET_LANGS[sourceLang] || ["zh", "en"];

  // If paragraphs haven't been parsed yet, we can't accurately count —
  // fall back to estimating from the chapter's sourceHtml length. It's
  // an overestimate because HTML tags aren't translated, but that's
  // conservative for the cost-gate warning.
  if (paras.length === 0) {
    const chapter = await db
      .select()
      .from(chapters)
      .where(eq(chapters.id, chapterId))
      .get();
    if (!chapter) return { queuedChars: 0, queuedTranslations: 0 };
    // Rough: strip tags by taking only ~60% of html length as body text.
    const approxChars = Math.round(chapter.sourceHtml.length * 0.6);
    return {
      queuedChars: approxChars * targetLangs.length,
      queuedTranslations: targetLangs.length,
    };
  }

  let queuedChars = 0;
  let queuedTranslations = 0;

  for (const para of paras) {
    const existingForPara = await db
      .select()
      .from(translations)
      .where(eq(translations.paragraphId, para.id))
      .all();
    for (const lang of targetLangs) {
      const existing = existingForPara.find((t) => t.lang === lang);
      if (existing && existing.status === "done") continue;
      queuedTranslations++;
      queuedChars += para.sourceText.length;
    }
  }

  return { queuedChars, queuedTranslations };
}
