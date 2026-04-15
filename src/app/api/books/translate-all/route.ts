import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, chapters } from "@/lib/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import {
  enqueueChapterTranslations,
  estimateChapterWork,
} from "@/lib/translate/enqueue";
import {
  getActiveProviderName,
  isLocalProvider,
} from "@/lib/llm/settings";

const EST_COST_PER_MTOK_USD = 0.75;

/**
 * Sweep every book the admin owns and queue every non-done chapter for
 * translation. Admin-only because the sensible use-case is "fire this
 * overnight against Ollama and come back in the morning" — non-admin
 * users have no reason to bulk-queue, and giving them a global sweep
 * button would be a foot-gun with paid providers.
 *
 * Same cost gate as /api/books/[id]/translate-all. When the provider is
 * a paid API, first POST returns an aggregate estimate; ?confirm=1 to
 * actually queue.
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const db = getDb();

  // Admin operates on their own uploads — even though admins can
  // technically read every user's private books, bulk-translating someone
  // else's uploads would both burn their credits and surprise them. Keep
  // the sweep scoped to the admin's own library.
  const myBooks = await db
    .select({ id: books.id, sourceLang: books.sourceLang, title: books.title })
    .from(books)
    .where(eq(books.userId, user.id))
    .all();

  // For each book, grab non-done chapter ids. Admin bypasses paywall
  // (hasChapterAccess always returns true for admins) so no per-chapter
  // access check is needed here.
  type Candidate = {
    bookId: string;
    sourceLang: string;
    title: string;
    chapterId: string;
  };
  const candidates: Candidate[] = [];
  for (const b of myBooks) {
    const chs = await db
      .select({ id: chapters.id })
      .from(chapters)
      .where(and(eq(chapters.bookId, b.id), ne(chapters.status, "done")))
      .orderBy(chapters.index)
      .all();
    for (const c of chs) {
      candidates.push({
        bookId: b.id,
        sourceLang: b.sourceLang,
        title: b.title,
        chapterId: c.id,
      });
    }
  }

  if (candidates.length === 0) {
    return NextResponse.json({
      queued: 0,
      chaptersQueued: 0,
      totalBooks: myBooks.length,
      provider: getActiveProviderName(),
    });
  }

  const confirm = request.nextUrl.searchParams.get("confirm") === "1";
  const local = isLocalProvider();

  if (!local && !confirm) {
    let totalChars = 0;
    let totalTranslations = 0;
    const byBook: Record<string, { title: string; chars: number }> = {};
    for (const c of candidates) {
      const est = await estimateChapterWork(c.chapterId, c.sourceLang);
      totalChars += est.queuedChars;
      totalTranslations += est.queuedTranslations;
      if (!byBook[c.bookId]) byBook[c.bookId] = { title: c.title, chars: 0 };
      byBook[c.bookId].chars += est.queuedChars;
    }
    const estimatedTokens = totalChars * 2;
    const estimatedCost =
      (estimatedTokens / 1_000_000) * EST_COST_PER_MTOK_USD;

    return NextResponse.json({
      requiresConfirm: true,
      provider: getActiveProviderName(),
      totalBooks: myBooks.length,
      booksToQueue: Object.keys(byBook).length,
      chaptersToQueue: candidates.length,
      estimatedTranslations: totalTranslations,
      estimatedInputTokens: estimatedTokens,
      estimatedCostUsd: Number(estimatedCost.toFixed(3)),
      perBook: Object.entries(byBook).map(([bookId, info]) => ({
        bookId,
        title: info.title,
        estimatedInputTokens: info.chars * 2,
      })),
      note: "Re-POST with ?confirm=1 to queue. Switch to Ollama to skip this gate.",
    });
  }

  let totalQueued = 0;
  let chaptersQueued = 0;
  for (const c of candidates) {
    const res = await enqueueChapterTranslations(c.chapterId, c.sourceLang);
    totalQueued += res.queued;
    if (res.queued > 0) chaptersQueued++;
  }

  return NextResponse.json({
    queued: totalQueued,
    chaptersQueued,
    totalBooks: myBooks.length,
    provider: getActiveProviderName(),
  });
}
