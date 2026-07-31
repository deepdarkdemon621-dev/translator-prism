// Classic Ebbinghaus fixed-interval review ladder (the default scheduler;
// FSRS in ./fsrs.ts is the adaptive opt-in). A card climbs one rung per
// successful review; each rung has a fixed gap taken from the interval
// list. Past the last rung the gap keeps doubling, capped at a year.
//
//   rung:     0    1    2    3    4    5     6     7    …
//   interval: 1d   2d   4d   7d   15d  30d   60d   120d …

import type { FsrsRating } from "./fsrs";

export const DEFAULT_EBBINGHAUS_INTERVALS = [1, 2, 4, 7, 15, 30];

const MAX_INTERVAL_DAYS = 365;
const RELEARN_MINUTES = 10;

export interface EbbinghausOutcome {
  /** Rungs climbed so far; stored in vocabulary.stage. */
  rung: number;
  intervalDays: number;
  nextReviewAt: string;
  relearning: boolean;
}

/** Interval for the climb onto rung `rung` (1-based climb; rung >= 1). */
function intervalForRung(rung: number, intervals: number[]): number {
  const idx = rung - 1;
  if (idx < intervals.length) return intervals[idx];
  const last = intervals[intervals.length - 1];
  const overflow = idx - intervals.length + 1;
  return Math.min(MAX_INTERVAL_DAYS, last * Math.pow(2, overflow));
}

/**
 * Apply one review on the fixed curve.
 *   again — back to the bottom, requeued in 10 minutes
 *   hard  — repeat the current rung's interval without advancing
 *   good  — climb one rung
 *   easy  — climb two rungs
 */
export function ebbinghausReview(
  rung: number,
  rating: FsrsRating,
  intervals: number[],
  now: Date,
): EbbinghausOutcome {
  const ladder = intervals.length > 0 ? intervals : DEFAULT_EBBINGHAUS_INTERVALS;
  const current = Math.max(0, rung);

  let next: number;
  let intervalDays: number;
  let relearning = false;

  if (rating === "again") {
    next = 0;
    intervalDays = RELEARN_MINUTES / (60 * 24);
    relearning = true;
  } else if (rating === "hard") {
    next = current;
    intervalDays = intervalForRung(Math.max(1, current), ladder);
  } else {
    next = current + (rating === "easy" ? 2 : 1);
    intervalDays = intervalForRung(next, ladder);
  }

  const nextReviewAt = new Date(
    now.getTime() + intervalDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  return { rung: next, intervalDays, nextReviewAt, relearning };
}

/** Parse a user-supplied interval override; null = use the default curve. */
export function parseIntervalOverride(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 12) {
      return null;
    }
    const nums = parsed.map(Number);
    if (nums.some((n) => !Number.isFinite(n) || n <= 0 || n > MAX_INTERVAL_DAYS)) {
      return null;
    }
    return nums;
  } catch {
    return null;
  }
}
