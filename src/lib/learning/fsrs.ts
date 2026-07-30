// FSRS-4.5 scheduler (pure functions, no I/O). Replaces the fixed Leitner
// ladder in src/lib/vocab/srs.ts: intervals adapt per card via a memory
// model (stability = days until recall probability drops to 90%,
// difficulty = how hard the card is to stabilize). Default weights from
// the published FSRS-4.5 parameter set; per-user optimization can come
// later from review_logs.
//
// State machine kept deliberately small for a web reviewer:
//   new --(any rating)--> learning (again) | review (hard/good/easy)
//   learning/relearning --(again)--> requeue in 10 min
//                       --(hard/good/easy)--> review with FSRS interval
//   review --(again)--> relearning (lapse), requeue in 10 min
//          --(hard/good/easy)--> review with FSRS interval

export type FsrsRating = "again" | "hard" | "good" | "easy";
export type FsrsState = "new" | "learning" | "review" | "relearning";

export interface FsrsCard {
  state: FsrsState;
  stability: number; // days
  difficulty: number; // 1..10
  lapses: number;
}

export interface FsrsReviewOutcome {
  card: FsrsCard;
  /** Scheduled gap in days; sub-day values encode the 10-minute requeue. */
  intervalDays: number;
  nextReviewAt: string;
}

const W = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474,
  0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755,
];

const DECAY = -0.5;
const FACTOR = 19 / 81; // 0.9 retention at t = S
const DESIRED_RETENTION = 0.9;
const MAX_INTERVAL_DAYS = 3650;
const RELEARN_MINUTES = 10;

const RATING_VALUE: Record<FsrsRating, number> = {
  again: 1,
  hard: 2,
  good: 3,
  easy: 4,
};

function clampDifficulty(d: number): number {
  return Math.min(10, Math.max(1, d));
}

function initStability(rating: FsrsRating): number {
  return Math.max(0.1, W[RATING_VALUE[rating] - 1]);
}

function initDifficulty(rating: FsrsRating): number {
  return clampDifficulty(W[4] - (RATING_VALUE[rating] - 3) * W[5]);
}

/** Recall probability after `elapsedDays` for a card with stability S. */
export function retrievability(elapsedDays: number, stability: number): number {
  const t = Math.max(0, elapsedDays);
  const s = Math.max(0.1, stability);
  return Math.pow(1 + (FACTOR * t) / s, DECAY);
}

function nextDifficulty(d: number, rating: FsrsRating): number {
  const next = d - W[6] * (RATING_VALUE[rating] - 3);
  // Mean reversion toward the initial "easy" difficulty keeps cards from
  // drifting to the extremes over hundreds of reviews.
  return clampDifficulty(W[7] * initDifficulty("easy") + (1 - W[7]) * next);
}

function nextStabilityOnSuccess(
  s: number,
  d: number,
  r: number,
  rating: FsrsRating,
): number {
  const hardPenalty = rating === "hard" ? W[15] : 1;
  const easyBonus = rating === "easy" ? W[16] : 1;
  const growth =
    Math.exp(W[8]) *
    (11 - d) *
    Math.pow(s, -W[9]) *
    (Math.exp(W[10] * (1 - r)) - 1) *
    hardPenalty *
    easyBonus;
  return s * (1 + growth);
}

function nextStabilityOnLapse(s: number, d: number, r: number): number {
  const forgot =
    W[11] *
    Math.pow(d, -W[12]) *
    (Math.pow(s + 1, W[13]) - 1) *
    Math.exp(W[14] * (1 - r));
  // A lapse never leaves the card more stable than it was.
  return Math.min(forgot, s);
}

/** Interval (days) at which retrievability decays to the desired retention. */
export function intervalForStability(stability: number): number {
  const raw =
    (stability / FACTOR) * (Math.pow(DESIRED_RETENTION, 1 / DECAY) - 1);
  return Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(raw)));
}

/**
 * Apply one review. `elapsedDays` is time since the previous review (0 for
 * first-ever review); `now` keeps the function pure for tests.
 */
export function reviewCard(
  card: FsrsCard,
  rating: FsrsRating,
  elapsedDays: number,
  now: Date,
): FsrsReviewOutcome {
  let next: FsrsCard;

  if (card.state === "new") {
    next = {
      state: rating === "again" ? "learning" : "review",
      stability: initStability(rating),
      difficulty: initDifficulty(rating),
      lapses: card.lapses,
    };
  } else if (rating === "again") {
    const r = retrievability(elapsedDays, card.stability);
    next = {
      state: "relearning",
      stability: nextStabilityOnLapse(card.stability, card.difficulty, r),
      difficulty: nextDifficulty(card.difficulty, rating),
      lapses: card.state === "review" ? card.lapses + 1 : card.lapses,
    };
  } else {
    const r = retrievability(elapsedDays, card.stability);
    next = {
      state: "review",
      stability: nextStabilityOnSuccess(
        card.stability,
        card.difficulty,
        r,
        rating,
      ),
      difficulty: nextDifficulty(card.difficulty, rating),
      lapses: card.lapses,
    };
  }

  let intervalDays: number;
  if (next.state === "learning" || next.state === "relearning") {
    intervalDays = RELEARN_MINUTES / (60 * 24);
  } else {
    intervalDays = intervalForStability(next.stability);
  }

  const nextReviewAt = new Date(
    now.getTime() + intervalDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  return { card: next, intervalDays, nextReviewAt };
}

// Legacy Leitner intervals, mirrored from src/lib/vocab/srs.ts. Used once
// per card to seed FSRS memory from the old `stage` field.
const LEGACY_INTERVALS = [1, 2, 4, 8, 16, 32, 64];

/**
 * Seed an FSRS card from a legacy Leitner row (state NULL in the DB).
 * A card at stage N was surviving N-th-rung intervals, so its stability is
 * approximated by that interval; difficulty starts neutral.
 */
export function seedFromLegacyStage(stage: number, lapses = 0): FsrsCard {
  if (stage <= 0) {
    return { state: "new", stability: 0, difficulty: initDifficulty("good"), lapses };
  }
  const rung = Math.min(stage, LEGACY_INTERVALS.length - 1);
  return {
    state: "review",
    stability: LEGACY_INTERVALS[rung],
    difficulty: initDifficulty("good"),
    lapses,
  };
}

/** Map FSRS state to the coarse display stage the existing UI understands. */
export function displayStageFor(card: FsrsCard): number {
  if (card.state === "new") return 0;
  if (card.state === "learning" || card.state === "relearning") return 1;
  // Review cards: bucket stability onto the legacy ladder for the badge.
  const idx = LEGACY_INTERVALS.findIndex((d) => card.stability < d);
  return idx === -1 ? 6 : Math.max(1, idx);
}
