import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  books,
  chapters,
  paragraphs,
  translations,
  users,
} from "@/lib/db/schema";
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { parseErrorCode, type LLMErrorCode } from "@/lib/llm/errors";
import { getActiveProviderName } from "@/lib/llm/settings";

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

  // Narrow to book ids the caller can see. Same rule as /api/books GET:
  // admin → everything, others → own uploads ∪ admin-public.
  let bookIds: string[];
  if (user.isAdmin) {
    bookIds = (await db.select({ id: books.id }).from(books).all()).map(
      (b) => b.id,
    );
  } else {
    const adminIds = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.isAdmin, 1))
        .all()
    ).map((u) => u.id);
    const visible = adminIds.length
      ? or(
          eq(books.userId, user.id),
          and(eq(books.visibility, "public"), inArray(books.userId, adminIds)),
        )
      : eq(books.userId, user.id);
    bookIds = (
      await db.select({ id: books.id }).from(books).where(visible).all()
    ).map((b) => b.id);
  }

  if (bookIds.length === 0) {
    return NextResponse.json({
      overall: { done: 0, pending: 0, processing: 0, failed: 0, total: 0 },
      books: [],
      throughput: {
        recentDone: 0,
        windowSeconds: THROUGHPUT_WINDOW_SECONDS,
        etaSeconds: null,
      },
      recentFailure: null,
      activeProvider: await getActiveProviderName(),
    });
  }

  // All three per-book / overall queries share this join shape. Turso
  // handles a 4-table join on indexed FKs in single-digit ms even with
  // tens of thousands of translations, so doing three passes is fine —
  // simpler than a single SELECT with conditional aggregation and keeps
  // the drizzle types honest.
  const statusCounts = await db
    .select({
      bookId: books.id,
      status: translations.status,
      count: sql<number>`COUNT(*)`,
    })
    .from(translations)
    .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
    .innerJoin(chapters, eq(paragraphs.chapterId, chapters.id))
    .innerJoin(books, eq(chapters.bookId, books.id))
    .where(inArray(books.id, bookIds))
    .groupBy(books.id, translations.status)
    .all();

  // Chapter-level tallies: a chapter counts as "done" once every text
  // paragraph has a completed translation in at least one target lang.
  // Using the books.status field instead would under-count because it
  // doesn't flip to 'done' until the last target lang finishes — we want
  // a softer "making progress" count.
  const chapterTotals = await db
    .select({ bookId: books.id, total: sql<number>`COUNT(*)` })
    .from(chapters)
    .innerJoin(books, eq(chapters.bookId, books.id))
    .where(inArray(books.id, bookIds))
    .groupBy(books.id)
    .all();

  const doneChapters = await db
    .select({ bookId: books.id, done: sql<number>`COUNT(*)` })
    .from(chapters)
    .innerJoin(books, eq(chapters.bookId, books.id))
    .where(and(inArray(books.id, bookIds), eq(chapters.status, "done")))
    .groupBy(books.id)
    .all();

  // Book titles + cover paths for display. One query for every book the
  // user can see (already scoped above), cheap. coverPath being non-null
  // is the signal for whether to render the thumbnail vs. a fallback.
  const bookMeta = await db
    .select({
      id: books.id,
      title: books.title,
      coverPath: books.coverPath,
    })
    .from(books)
    .where(inArray(books.id, bookIds))
    .all();
  const metaById = new Map(bookMeta.map((b) => [b.id, b]));

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
  const ensure = (id: string): BookRow => {
    let row = byBookId.get(id);
    if (!row) {
      const meta = metaById.get(id);
      row = {
        id,
        title: meta?.title ?? "(untitled)",
        hasCover: !!meta?.coverPath,
        done: 0,
        pending: 0,
        processing: 0,
        failed: 0,
        total: 0,
        doneChapters: 0,
        totalChapters: 0,
      };
      byBookId.set(id, row);
    }
    return row;
  };
  for (const r of statusCounts) {
    const row = ensure(r.bookId);
    const n = Number(r.count);
    row.total += n;
    if (r.status === "done") row.done += n;
    else if (r.status === "pending") row.pending += n;
    else if (r.status === "processing") row.processing += n;
    else if (r.status === "failed") row.failed += n;
  }
  for (const r of chapterTotals) {
    ensure(r.bookId).totalChapters = Number(r.total);
  }
  for (const r of doneChapters) {
    ensure(r.bookId).doneChapters = Number(r.done);
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
    .where(
      and(
        inArray(chapters.bookId, bookIds),
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
      .where(
        and(
          inArray(chapters.bookId, bookIds),
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
