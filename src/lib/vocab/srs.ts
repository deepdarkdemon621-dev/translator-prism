/**
 * Leitner-style spaced repetition intervals, in days.
 *
 * We keep this simple on purpose: a fixed ladder of 7 boxes. Rating "good"
 * advances one step, "easy" advances two, and "again" resets to stage 0 and
 * makes the card due in 10 minutes (so it comes back around inside the same
 * session). This is deliberately lighter than SM-2 — no ease factors, no
 * learning steps — which keeps the UX and the data model predictable for
 * casual vocab study.
 */
const INTERVAL_DAYS = [1, 2, 4, 8, 16, 32, 64] as const;
const MAX_STAGE = INTERVAL_DAYS.length - 1;
const AGAIN_MINUTES = 10;

export type ReviewRating = "again" | "good" | "easy";

export interface SrsUpdate {
  stage: number;
  nextReviewAt: string;
  lastReviewedAt: string;
  correctDelta: number;
  incorrectDelta: number;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function addMinutes(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString();
}

/**
 * Given a card's current SRS stage and the user's rating, return the new
 * stage, when it's next due, and deltas for the correct/incorrect counters.
 */
export function applyReview(
  currentStage: number,
  rating: ReviewRating,
  now: Date = new Date(),
): SrsUpdate {
  const nowIso = now.toISOString();

  if (rating === "again") {
    return {
      stage: 0,
      nextReviewAt: addMinutes(nowIso, AGAIN_MINUTES),
      lastReviewedAt: nowIso,
      correctDelta: 0,
      incorrectDelta: 1,
    };
  }

  const bump = rating === "easy" ? 2 : 1;
  const nextStage = Math.min(MAX_STAGE, Math.max(0, currentStage) + bump);
  const interval = INTERVAL_DAYS[nextStage];
  return {
    stage: nextStage,
    nextReviewAt: addDays(nowIso, interval),
    lastReviewedAt: nowIso,
    correctDelta: 1,
    incorrectDelta: 0,
  };
}

/** Human-readable label for a card's mastery stage. */
export function stageLabel(stage: number): string {
  if (stage <= 0) return "New";
  if (stage >= MAX_STAGE) return "Mastered";
  if (stage <= 2) return "Learning";
  if (stage <= 4) return "Familiar";
  return "Strong";
}

export function stageInterval(stage: number): number {
  const i = Math.max(0, Math.min(MAX_STAGE, stage));
  return INTERVAL_DAYS[i];
}

export { MAX_STAGE, INTERVAL_DAYS };
