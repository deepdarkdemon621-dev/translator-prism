import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { vocabulary } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { applyReview, type ReviewRating } from "@/lib/vocab/srs";
import { getCurrentUser } from "@/lib/auth";

const VALID_RATINGS = new Set(["again", "good", "easy"]);

/**
 * Record an SRS review for a vocabulary entry. Advances (or resets) the
 * card's stage and schedules the next review time. Pure application logic
 * lives in @/lib/vocab/srs so this route stays thin.
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
      { error: "`rating` must be one of: again, good, easy" },
      { status: 400 },
    );
  }

  // Scope by user so another user's card id returns 404 instead of
  // letting a stranger advance someone else's SRS stage.
  const existing = db
    .select()
    .from(vocabulary)
    .where(and(eq(vocabulary.id, id), eq(vocabulary.userId, user.id)))
    .get();
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const update = applyReview(existing.stage, rating as ReviewRating);

  db.update(vocabulary)
    .set({
      stage: update.stage,
      nextReviewAt: update.nextReviewAt,
      lastReviewedAt: update.lastReviewedAt,
      // Use SQL expressions so counter updates are atomic and don't rely on
      // whatever was in `existing` (avoids lost-update races).
      correctCount: update.correctDelta
        ? sql`${vocabulary.correctCount} + ${update.correctDelta}`
        : existing.correctCount,
      incorrectCount: update.incorrectDelta
        ? sql`${vocabulary.incorrectCount} + ${update.incorrectDelta}`
        : existing.incorrectCount,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(vocabulary.id, id))
    .run();

  return NextResponse.json({
    id,
    stage: update.stage,
    nextReviewAt: update.nextReviewAt,
  });
}
