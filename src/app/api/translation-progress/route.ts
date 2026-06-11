import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  books,
  chapters,
  paragraphs,
  translations,
} from "@/lib/db/schema";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { parseErrorCode, type LLMErrorCode } from "@/lib/llm/errors";
import { getActiveProviderName } from "@/lib/llm/settings";
import { visibleBooksWhereForActor } from "@/lib/library/visibility";

// 5-minute throughput window for ETA. Long enough to smooth out the gaps
// between worker polls (every few seconds) and short enough to react when
// the user pauses / unpauses Ollama. If the window has zero completions,
// we report ETA as unknown rather than extrapolating off noise.
const THROUGHPUT_WINDOW_SECONDS = 300;

/**
 * Translation-queue dashboard. Shows where work stands right now and how
 * fast it's moving — used by the /progress page so the user doesn't need
 * to SSH into the worker box and run check-progress.mjs.
 *
 * Scope mirrors the library: admin sees everything, regular users see
 * only translations belonging to books they can access (their own +
 * admin-uploaded public books). Keeps a regular user from counting
 * someone else's queue.
 */
export async function GET() {
  const user = await getCurrentUser();
  const db = getDb();

  const visibleBookWhere = await visibleBooksWhereForActor(db, user);

  // Per-book translation status tallies in a single query: SUM(CASE)
  // collapses four separate GROUP BY rows (one per status) into one row
  // per book, so we process ~1 row per book instead of up to 4.
  // The books join applies the shared visibility predicate without first
  // materializing a JS-side book-id list. Relies on the paragraph/chapter
  // indexes from migration 0009 plus the visibility indexes from 0012.
  const translationAgg = await db
    .select({
      bookId: chapters.bookId,
      done: sql<number>`SUM(CASE WHEN ${translations.status} = 'done' THEN 1 ELSE 0 END)`,
      pending: sql<number>`SUM(CASE WHEN ${translations.status} = 'pending' THEN 1 ELSE 0 END)`,
      processing: sql<number>`SUM(CASE WHEN ${translations.status} = 'processing' THEN 1 ELSE 0 END)`,
      failed: sql<number>`SUM(CASE WHEN ${translations.status} = 'failed' THEN 1 ELSE 0 END)`,
      total: sql<number>`COUNT(*)`,
    })
    .from(translations)
    .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
    .innerJoin(chapters, eq(paragraphs.chapterId, chapters.id))
    .innerJoin(books, eq(chapters.bookId, books.id))
    .where(visibleBookWhere)
    .groupBy(chapters.bookId)
    .all();

  // Chapter counts + book metadata (title, cover) in one pass. LEFT JOIN
  // so books with zero chapters still appear; SUM(CASE chapter.id IS NOT NULL)
  // avoids counting the single NULL row LEFT JOIN produces for empty books.
  // Replaces three previous queries (chapterTotals + doneChapters + bookMeta).
  const bookAgg = await db
    .select({
      id: books.id,
      title: books.title,
      coverPath: books.coverPath,
      totalChapters: sql<number>`SUM(CASE WHEN ${chapters.id} IS NOT NULL THEN 1 ELSE 0 END)`,
      doneChapters: sql<number>`SUM(CASE WHEN ${chapters.status} = 'done' OR (
        NOT EXISTS (
          SELECT 1 FROM paragraphs p_text
          WHERE p_text.chapter_id = ${chapters.id} AND p_text.kind = 'text'
        )
        AND EXISTS (
          SELECT 1 FROM paragraphs p_any
          WHERE p_any.chapter_id = ${chapters.id}
        )
      ) THEN 1 ELSE 0 END)`,
    })
    .from(books)
    .leftJoin(chapters, eq(chapters.bookId, books.id))
    .where(visibleBookWhere)
    .groupBy(books.id)
    .all();

  // Shape per-book breakdown: { id, title, done, total, doneChapters,
  // totalChapters }. Books with no translations queued at all are
  // omitted — they'd just be visual noise on the progress page.
  type BookRow = {
    id: string;
    title: string;
    hasCover: boolean;
    done: number;
    pending: number;
    processing: number;
    failed: number;
    total: number;
    doneChapters: number;
    totalChapters: number;
  };
  const byBookId = new Map<string, BookRow>();
  for (const r of bookAgg) {
    byBookId.set(r.id, {
      id: r.id,
      title: r.title,
      hasCover: !!r.coverPath,
      done: 0,
      pending: 0,
      processing: 0,
      failed: 0,
      total: 0,
      doneChapters: Number(r.doneChapters ?? 0),
      totalChapters: Number(r.totalChapters ?? 0),
    });
  }
  for (const r of translationAgg) {
    const row = byBookId.get(r.bookId);
    if (!row) continue;
    row.done = Number(r.done ?? 0);
    row.pending = Number(r.pending ?? 0);
    row.processing = Number(r.processing ?? 0);
    row.failed = Number(r.failed ?? 0);
    row.total = Number(r.total ?? 0);
  }

  const overall = { done: 0, pending: 0, processing: 0, failed: 0, total: 0 };
  for (const row of byBookId.values()) {
    overall.done += row.done;
    overall.pending += row.pending;
    overall.processing += row.processing;
    overall.failed += row.failed;
    overall.total += row.total;
  }

  // Throughput: how many translations flipped to 'done' in the last N
  // seconds. Uses updated_at because the worker bumps it every time it
  // commits a row. ETA = remaining / (recentDone / window). Null when
  // nothing's moving, so the UI can show "—" instead of "Infinity".
  const since = new Date(
    Date.now() - THROUGHPUT_WINDOW_SECONDS * 1000,
  ).toISOString();
  const recentDoneRow = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(translations)
    .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
    .innerJoin(chapters, eq(paragraphs.chapterId, chapters.id))
    .innerJoin(books, eq(chapters.bookId, books.id))
    .where(
      and(
        visibleBookWhere,
        eq(translations.status, "done"),
        gt(translations.updatedAt, since),
      ),
    )
    .get();
  const recentDone = Number(recentDoneRow?.count ?? 0);
  const remaining = overall.pending + overall.processing;
  const etaSeconds =
    recentDone > 0 && remaining > 0
      ? Math.round((remaining / recentDone) * THROUGHPUT_WINDOW_SECONDS)
      : null;

  const bookList = Array.from(byBookId.values())
    .filter((b) => b.total > 0)
    .sort((a, b) => {
      // Books with pending work bubble to the top — that's what the user
      // is actually watching. Ties broken by title for stable ordering.
      const aActive = a.pending + a.processing;
      const bActive = b.pending + b.processing;
      if (aActive !== bActive) return bActive - aActive;
      return a.title.localeCompare(b.title);
    });

  // Most recent failure within scope — lets the UI surface a "quota
  // exhausted / API key invalid / etc." banner without having to NLP
  // raw error strings. We only read one row (the freshest), so even
  // heavy failure counts don't blow up the response size.
  let recentFailure: {
    code: LLMErrorCode;
    message: string;
    at: string;
  } | null = null;
  if (overall.failed > 0) {
    const latestFailed = await db
      .select({
        errorMessage: translations.errorMessage,
        updatedAt: translations.updatedAt,
      })
      .from(translations)
      .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
      .innerJoin(chapters, eq(paragraphs.chapterId, chapters.id))
      .innerJoin(books, eq(chapters.bookId, books.id))
      .where(
        and(
          visibleBookWhere,
          eq(translations.status, "failed"),
        ),
      )
      .orderBy(desc(translations.updatedAt))
      .limit(1)
      .get();
    if (latestFailed) {
      recentFailure = {
        code: parseErrorCode(latestFailed.errorMessage),
        message: latestFailed.errorMessage ?? "",
        at: latestFailed.updatedAt,
      };
    }
  }

  return NextResponse.json({
    overall,
    books: bookList,
    throughput: {
      recentDone,
      windowSeconds: THROUGHPUT_WINDOW_SECONDS,
      etaSeconds,
    },
    recentFailure,
    activeProvider: await getActiveProviderName(),
  });
}
