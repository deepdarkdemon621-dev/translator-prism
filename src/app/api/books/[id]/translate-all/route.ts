import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { chapters } from "@/lib/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { loadBookForWrite } from "@/lib/access";
import { hasChapterAccess } from "@/lib/billing";
import {
  enqueueChaptersBulk,
  estimateChapterWork,
} from "@/lib/translate/enqueue";
import {
  getActiveProviderName,
  isLocalProvider,
} from "@/lib/llm/settings";

// Blended cost estimate per 1M tokens. Intentionally conservative — the
// user asked us to flag cost for remote providers, and we'd rather
// over-estimate than surprise. Not provider-specific; covers Claude
// Sonnet / GPT-4o-mini / OpenRouter equivalents to within a factor of 2.
const EST_COST_PER_MTOK_USD = 0.75;

/**
 * Batch-translate every accessible chapter in one book. Designed for the
 * "leave it running overnight" workflow: the caller hits this once per
 * book rather than having to click every chapter.
 *
 * Cost gate: when the active LLM provider is a paid API (anything except
 * local Ollama), the first call returns a cost estimate and does NOT
 * queue. Caller re-POSTs with ?confirm=1 to actually kick things off.
 * Local providers skip the gate entirely — free tokens, no reason to ask.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  const result = await loadBookForWrite(id);
  if (!result.book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }
  if (result.forbidden) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const { user, book } = result;

  // Chapters already fully done have nothing to do — skip them cheaply.
  const candidateChapters = await db
    .select({ id: chapters.id, status: chapters.status })
    .from(chapters)
    .where(and(eq(chapters.bookId, id), ne(chapters.status, "done")))
    .orderBy(chapters.index)
    .all();

  // Drop chapters the caller isn't allowed to translate (paywall). Admin
  // / public / purchased chapters pass; anything else is silently skipped.
  const accessibleChapters: typeof candidateChapters = [];
  for (const ch of candidateChapters) {
    if (await hasChapterAccess(user, ch.id)) {
      accessibleChapters.push(ch);
    }
  }

  const lockedSkipped = candidateChapters.length - accessibleChapters.length;

  if (accessibleChapters.length === 0) {
    return NextResponse.json({
      queued: 0,
      chaptersQueued: 0,
      chaptersSkippedLocked: lockedSkipped,
      totalChapters: candidateChapters.length,
      provider: await getActiveProviderName(),
    });
  }

  const confirm = request.nextUrl.searchParams.get("confirm") === "1";
  const local = await isLocalProvider();

  // Cost gate for paid providers. Compute total pending work across all
  // accessible chapters without queueing anything, so the user can decide
  // whether to proceed. Local Ollama bypasses this.
  if (!local && !confirm) {
    let totalChars = 0;
    let totalTranslations = 0;
    for (const ch of accessibleChapters) {
      const est = await estimateChapterWork(ch.id, book.sourceLang);
      totalChars += est.queuedChars;
      totalTranslations += est.queuedTranslations;
    }
    // Rough: ~1 input tok per source char + ~1 output tok per source char.
    const estimatedTokens = totalChars * 2;
    const estimatedCost =
      (estimatedTokens / 1_000_000) * EST_COST_PER_MTOK_USD;

    return NextResponse.json({
      requiresConfirm: true,
      provider: await getActiveProviderName(),
      chaptersToQueue: accessibleChapters.length,
      chaptersSkippedLocked: lockedSkipped,
      totalChapters: candidateChapters.length,
      estimatedTranslations: totalTranslations,
      estimatedInputTokens: estimatedTokens,
      estimatedCostUsd: Number(estimatedCost.toFixed(3)),
      note: "Re-POST with ?confirm=1 to queue. Switch to Ollama to skip this gate.",
    });
  }

  // Bulk enqueue instead of a per-chapter loop: the loop version timed out
  // on Vercel for legacy books (per-chapter EPUB extraction), silently
  // leaving the rest of the book un-enqueued. Legacy chapters that still
  // need extraction run under a time budget; any remainder is reported so
  // the client can re-POST to continue.
  const res = await enqueueChaptersBulk(
    accessibleChapters.map((ch) => ch.id),
    book.sourceLang,
    { timeBudgetMs: 240_000 },
  );

  return NextResponse.json({
    queued: res.queued,
    chaptersQueued: res.chaptersQueued,
    chaptersSkippedLocked: lockedSkipped,
    totalChapters: candidateChapters.length,
    remainingChapters: res.remainingChapterIds.length,
    provider: await getActiveProviderName(),
  });
}
