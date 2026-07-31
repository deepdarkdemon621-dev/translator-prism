import { describe, expect, it } from "vitest";
import {
  DEFAULT_EBBINGHAUS_INTERVALS,
  ebbinghausReview,
  parseIntervalOverride,
} from "../ebbinghaus";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const CURVE = DEFAULT_EBBINGHAUS_INTERVALS;

describe("ebbinghausReview", () => {
  it("climbs the classic curve one rung per good rating", () => {
    let rung = 0;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = ebbinghausReview(rung, "good", CURVE, NOW);
      seen.push(res.intervalDays);
      rung = res.rung;
    }
    expect(seen).toEqual([1, 2, 4, 7, 15, 30]);
    expect(rung).toBe(6);
  });

  it("doubles past the ladder, capped at a year", () => {
    expect(ebbinghausReview(6, "good", CURVE, NOW).intervalDays).toBe(60);
    expect(ebbinghausReview(7, "good", CURVE, NOW).intervalDays).toBe(120);
    expect(ebbinghausReview(20, "good", CURVE, NOW).intervalDays).toBe(365);
  });

  it("easy skips a rung", () => {
    const res = ebbinghausReview(0, "easy", CURVE, NOW);
    expect(res.rung).toBe(2);
    expect(res.intervalDays).toBe(2);
  });

  it("hard repeats the current rung without advancing", () => {
    const res = ebbinghausReview(3, "hard", CURVE, NOW);
    expect(res.rung).toBe(3);
    expect(res.intervalDays).toBe(4); // repeat the interval that got us here
  });

  it("again drops to the bottom with a 10-minute requeue", () => {
    const res = ebbinghausReview(5, "again", CURVE, NOW);
    expect(res.rung).toBe(0);
    expect(res.relearning).toBe(true);
    expect(res.intervalDays).toBeLessThan(0.01);
    const dueMs = new Date(res.nextReviewAt).getTime() - NOW.getTime();
    expect(dueMs).toBe(10 * 60 * 1000);
  });

  it("honors a custom interval list", () => {
    const custom = [0.5, 3, 9];
    expect(ebbinghausReview(0, "good", custom, NOW).intervalDays).toBe(0.5);
    expect(ebbinghausReview(2, "good", custom, NOW).intervalDays).toBe(9);
    expect(ebbinghausReview(3, "good", custom, NOW).intervalDays).toBe(18);
  });
});

describe("parseIntervalOverride", () => {
  it("accepts a valid JSON day list", () => {
    expect(parseIntervalOverride("[1,3,7,14]")).toEqual([1, 3, 7, 14]);
  });

  it("rejects malformed, empty, oversized, and out-of-range input", () => {
    expect(parseIntervalOverride(null)).toBeNull();
    expect(parseIntervalOverride("not json")).toBeNull();
    expect(parseIntervalOverride("[]")).toBeNull();
    expect(parseIntervalOverride(JSON.stringify(Array(13).fill(1)))).toBeNull();
    expect(parseIntervalOverride("[0]")).toBeNull();
    expect(parseIntervalOverride("[400]")).toBeNull();
    expect(parseIntervalOverride('["a"]')).toBeNull();
  });
});
