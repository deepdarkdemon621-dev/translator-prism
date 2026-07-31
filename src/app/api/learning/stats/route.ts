import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  readingSessions,
  reviewLogs,
  vocabulary,
  wordStatus,
} from "@/lib/db/schema";
import { and, eq, gte, or, sql } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";

const WINDOW_DAYS = 30;

/**
 * Aggregates for the learning dashboard: per-day review and reading
 * activity, vocabulary growth, retention, and the current streak (any day
 * with a review or reading heartbeat counts).
 */
export async function GET() {
  const user = await getCurrentUser();
  const db = getDb();
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const reviewRows = await db
    .select({
      day: sql<string>`substr(${reviewLogs.reviewedAt}, 1, 10)`,
      total: sql<number>`COUNT(*)`,
      correct: sql<number>`SUM(CASE WHEN ${reviewLogs.rating} != 'again' THEN 1 ELSE 0 END)`,
    })
    .from(reviewLogs)
    .where(
      and(
        eq(reviewLogs.userId, user.id),
        gte(sql`substr(${reviewLogs.reviewedAt}, 1, 10)`, since),
      ),
    )
    .groupBy(sql`substr(${reviewLogs.reviewedAt}, 1, 10)`)
    .all();

  const readingRows = await db
    .select({
      day: readingSessions.day,
      durationMs: sql<number>`SUM(${readingSessions.durationMs})`,
      charsRead: sql<number>`SUM(${readingSessions.charsRead})`,
    })
    .from(readingSessions)
    .where(and(eq(readingSessions.userId, user.id), gte(readingSessions.day, since)))
    .groupBy(readingSessions.day)
    .all();

  const growthRows = await db
    .select({
      day: sql<string>`substr(${vocabulary.createdAt}, 1, 10)`,
      added: sql<number>`COUNT(*)`,
    })
    .from(vocabulary)
    .where(
      and(
        eq(vocabulary.userId, user.id),
        gte(sql`substr(${vocabulary.createdAt}, 1, 10)`, since),
      ),
    )
    .groupBy(sql`substr(${vocabulary.createdAt}, 1, 10)`)
    .all();

  const totals = await db
    .select({
      totalWords: sql<number>`COUNT(*)`,
      due: sql<number>`SUM(CASE WHEN ${vocabulary.nextReviewAt} IS NULL OR ${vocabulary.nextReviewAt} <= ${new Date().toISOString()} THEN 1 ELSE 0 END)`,
    })
    .from(vocabulary)
    .where(eq(vocabulary.userId, user.id))
    .get();

  const knownRow = await db
    .select({ known: sql<number>`COUNT(*)` })
    .from(wordStatus)
    .where(and(eq(wordStatus.userId, user.id), eq(wordStatus.status, "known")))
    .get();

  // All-time activity days (bounded to a year) for streak computation.
  const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const activityDays = new Set<string>();
  const reviewDays = await db
    .select({ day: sql<string>`DISTINCT substr(${reviewLogs.reviewedAt}, 1, 10)` })
    .from(reviewLogs)
    .where(
      and(
        eq(reviewLogs.userId, user.id),
        gte(sql`substr(${reviewLogs.reviewedAt}, 1, 10)`, yearAgo),
      ),
    )
    .all();
  for (const r of reviewDays) activityDays.add(r.day);
  const sessionDays = await db
    .select({ day: readingSessions.day })
    .from(readingSessions)
    .where(
      and(
        eq(readingSessions.userId, user.id),
        gte(readingSessions.day, yearAgo),
        or(
          sql`${readingSessions.durationMs} > 0`,
          sql`${readingSessions.charsRead} > 0`,
        ),
      ),
    )
    .all();
  for (const r of sessionDays) activityDays.add(r.day);

  // Streak counts back from today (or yesterday, so an unfinished today
  // doesn't break it).
  let streak = 0;
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  let cursor = new Date(today);
  if (!activityDays.has(fmt(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (activityDays.has(fmt(cursor))) {
    streak++;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }

  const totalReviews = reviewRows.reduce((sum, r) => sum + Number(r.total), 0);
  const totalCorrect = reviewRows.reduce((sum, r) => sum + Number(r.correct), 0);

  // Retention split per algorithm so the user can judge the Ebbinghaus
  // curve against FSRS with their own data. Pre-0018 logs were FSRS.
  const algoRows = await db
    .select({
      algorithm: sql<string>`COALESCE(${reviewLogs.algorithm}, 'fsrs')`,
      total: sql<number>`COUNT(*)`,
      correct: sql<number>`SUM(CASE WHEN ${reviewLogs.rating} != 'again' THEN 1 ELSE 0 END)`,
    })
    .from(reviewLogs)
    .where(
      and(
        eq(reviewLogs.userId, user.id),
        gte(sql`substr(${reviewLogs.reviewedAt}, 1, 10)`, since),
      ),
    )
    .groupBy(sql`COALESCE(${reviewLogs.algorithm}, 'fsrs')`)
    .all();

  return NextResponse.json({
    windowDays: WINDOW_DAYS,
    streak,
    totalWords: Number(totals?.totalWords ?? 0),
    dueNow: Number(totals?.due ?? 0),
    knownWords: Number(knownRow?.known ?? 0),
    retention: totalReviews > 0 ? totalCorrect / totalReviews : null,
    retentionByAlgorithm: algoRows.map((r) => ({
      algorithm: r.algorithm,
      total: Number(r.total),
      retention: Number(r.total) > 0 ? Number(r.correct) / Number(r.total) : null,
    })),
    reviewsByDay: reviewRows.map((r) => ({
      day: r.day,
      total: Number(r.total),
      correct: Number(r.correct),
    })),
    readingByDay: readingRows.map((r) => ({
      day: r.day,
      durationMs: Number(r.durationMs),
      charsRead: Number(r.charsRead),
    })),
    vocabAddedByDay: growthRows.map((r) => ({ day: r.day, added: Number(r.added) })),
  });
}
