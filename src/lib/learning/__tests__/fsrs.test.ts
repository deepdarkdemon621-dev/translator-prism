import { describe, expect, it } from "vitest";
import {
  intervalForStability,
  retrievability,
  reviewCard,
  seedFromLegacyStage,
  displayStageFor,
  type FsrsCard,
} from "../fsrs";

const NOW = new Date("2026-07-30T12:00:00.000Z");

const newCard: FsrsCard = { state: "new", stability: 0, difficulty: 0, lapses: 0 };

describe("FSRS scheduler", () => {
  it("orders first intervals by rating: easy > good > again/hard requeue semantics", () => {
    const again = reviewCard(newCard, "again", 0, NOW);
    const hard = reviewCard(newCard, "hard", 0, NOW);
    const good = reviewCard(newCard, "good", 0, NOW);
    const easy = reviewCard(newCard, "easy", 0, NOW);

    expect(again.card.state).toBe("learning");
    expect(again.intervalDays).toBeLessThan(0.01); // 10-minute requeue
    expect(hard.card.state).toBe("review");
    expect(good.intervalDays).toBeGreaterThan(hard.intervalDays);
    expect(easy.intervalDays).toBeGreaterThan(good.intervalDays);
    expect(good.intervalDays).toBeGreaterThanOrEqual(3); // S0(good) ≈ 3.7d
  });

  it("assigns higher difficulty to harder first ratings", () => {
    const hard = reviewCard(newCard, "hard", 0, NOW);
    const good = reviewCard(newCard, "good", 0, NOW);
    const easy = reviewCard(newCard, "easy", 0, NOW);
    expect(hard.card.difficulty).toBeGreaterThan(good.card.difficulty);
    expect(good.card.difficulty).toBeGreaterThan(easy.card.difficulty);
    for (const c of [hard, good, easy]) {
      expect(c.card.difficulty).toBeGreaterThanOrEqual(1);
      expect(c.card.difficulty).toBeLessThanOrEqual(10);
    }
  });

  it("grows stability on successful review and shrinks it on a lapse", () => {
    const reviewState: FsrsCard = {
      state: "review",
      stability: 10,
      difficulty: 5,
      lapses: 0,
    };
    const success = reviewCard(reviewState, "good", 10, NOW);
    expect(success.card.stability).toBeGreaterThan(10);
    expect(success.card.state).toBe("review");

    const lapse = reviewCard(reviewState, "again", 10, NOW);
    expect(lapse.card.stability).toBeLessThan(10);
    expect(lapse.card.state).toBe("relearning");
    expect(lapse.card.lapses).toBe(1);
    expect(lapse.intervalDays).toBeLessThan(0.01);
  });

  it("does not count a lapse when failing out of learning", () => {
    const learning: FsrsCard = {
      state: "learning",
      stability: 0.5,
      difficulty: 6,
      lapses: 0,
    };
    const res = reviewCard(learning, "again", 0.01, NOW);
    expect(res.card.lapses).toBe(0);
    expect(res.card.state).toBe("relearning");
  });

  it("graduates relearning cards back to review on success", () => {
    const relearning: FsrsCard = {
      state: "relearning",
      stability: 2,
      difficulty: 7,
      lapses: 2,
    };
    const res = reviewCard(relearning, "good", 0.01, NOW);
    expect(res.card.state).toBe("review");
    expect(res.intervalDays).toBeGreaterThanOrEqual(1);
  });

  it("rewards overdue successful reviews with bigger stability jumps", () => {
    const card: FsrsCard = { state: "review", stability: 10, difficulty: 5, lapses: 0 };
    const onTime = reviewCard(card, "good", 10, NOW);
    const overdue = reviewCard(card, "good", 30, NOW);
    expect(overdue.card.stability).toBeGreaterThan(onTime.card.stability);
  });

  it("retrievability decays with time and equals ~0.9 at t = S", () => {
    expect(retrievability(0, 10)).toBe(1);
    expect(retrievability(10, 10)).toBeCloseTo(0.9, 2);
    expect(retrievability(40, 10)).toBeLessThan(retrievability(10, 10));
  });

  it("interval at desired retention roughly equals stability", () => {
    expect(intervalForStability(10)).toBe(10);
    expect(intervalForStability(0.4)).toBe(1); // floor at one day
  });

  it("seeds legacy Leitner stages into equivalent FSRS memory", () => {
    expect(seedFromLegacyStage(0).state).toBe("new");
    const mid = seedFromLegacyStage(3);
    expect(mid.state).toBe("review");
    expect(mid.stability).toBe(8);
    const top = seedFromLegacyStage(6);
    expect(top.stability).toBe(64);
    expect(displayStageFor(top)).toBe(6);
  });

  it("keeps schedules pure and deterministic", () => {
    const a = reviewCard(newCard, "good", 0, NOW);
    const b = reviewCard(newCard, "good", 0, NOW);
    expect(a).toEqual(b);
    expect(a.nextReviewAt > NOW.toISOString()).toBe(true);
  });
});
