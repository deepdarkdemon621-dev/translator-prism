import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { reviewLogs, vocabulary } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  displayStageFor,
  reviewCard,
  seedFromLegacyStage,
  type FsrsCard,
  type FsrsRating,
  type FsrsState,
} from "@/lib/learning/fsrs";
import { getCurrentUser } from "@/lib/auth";

const VALID_RATINGS = new Set(["again", "hard", "good", "easy"]);

/**
 * Record an SRS review for a vocabulary entry. Scheduling runs through the
 * FSRS engine (@/lib/learning/fsrs); cards still on the legacy Leitner
 * ladder (state NULL) are seeded from their stage on this first review.
 * Every review appends a review_logs row — the append-only log feeds the
 * dashboard and future parameter tuning.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const user = await getCurrentUser();

  let body: { rating?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rating = body.rating;
  if (!rating || !VALID_RATINGS.has(rating)) {
    return NextResponse.json(
      { error: "`rating` must be one of: again, hard, good, easy" },
      { status: 400 },
    );
  }

  // Scope by user so another user's card id returns 404 instead of
  // letting a stranger advance someone else's SRS state.
  const existing = await db
    .select()
    .from(vocabulary)
    .where(and(eq(vocabulary.id, id), eq(vocabulary.userId, user.id)))
    .get();
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const card: FsrsCard =
    existing.state != null
      ? {
          state: existing.state as FsrsState,
          stability: existing.stability ?? 0,
          difficulty: existing.difficulty ?? 5,
          lapses: existing.lapses ?? 0,
        }
      : seedFromLegacyStage(existing.stage, existing.lapses ?? 0);

  const now = new Date();
  const elapsedDays = existing.lastReviewedAt
    ? Math.max(
        0,
        (now.getTime() - new Date(existing.lastReviewedAt).getTime()) /
          86_400_000,
      )
    : 0;

  const outcome = reviewCard(card, rating as FsrsRating, elapsedDays, now);
  const nowIso = now.toISOString();
  const isCorrect = rating !== "again";

  await db.transaction(async (tx) => {
    await tx
      .update(vocabulary)
      .set({
        state: outcome.card.state,
        stability: outcome.card.stability,
        difficulty: outcome.card.difficulty,
        lapses: outcome.card.lapses,
        stage: displayStageFor(outcome.card),
        nextReviewAt: outcome.nextReviewAt,
        lastReviewedAt: nowIso,
        // SQL expressions keep counter updates atomic (no lost-update race).
        correctCount: isCorrect
          ? sql`${vocabulary.correctCount} + 1`
          : existing.correctCount,
        incorrectCount: isCorrect
          ? existing.incorrectCount
          : sql`${vocabulary.incorrectCount} + 1`,
        updatedAt: nowIso,
      })
      .where(eq(vocabulary.id, id));
    await tx.insert(reviewLogs).values({
      id: randomUUID(),
      vocabularyId: id,
      userId: user.id,
      rating,
      stateBefore: existing.state ?? null,
      stageBefore: existing.stage,
      stabilityBefore: existing.stability ?? null,
      difficultyBefore: existing.difficulty ?? null,
      elapsedDays,
      scheduledDays: outcome.intervalDays,
      reviewedAt: nowIso,
    });
  });

  return NextResponse.json({
    id,
    stage: displayStageFor(outcome.card),
    state: outcome.card.state,
    nextReviewAt: outcome.nextReviewAt,
  });
}
