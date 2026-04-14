import { describe, it, expect } from "vitest";
import { applyReview, stageLabel, INTERVAL_DAYS, MAX_STAGE } from "../srs";

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("applyReview", () => {
  it("advances one stage on 'good'", () => {
    const r = applyReview(0, "good", NOW);
    expect(r.stage).toBe(1);
    expect(r.correctDelta).toBe(1);
    expect(r.incorrectDelta).toBe(0);
  });

  it("advances two stages on 'easy'", () => {
    const r = applyReview(0, "easy", NOW);
    expect(r.stage).toBe(2);
  });

  it("resets to stage 0 and re-queues inside the session on 'again'", () => {
    const r = applyReview(4, "again", NOW);
    expect(r.stage).toBe(0);
    expect(r.incorrectDelta).toBe(1);
    // Should be due ~10 minutes from now — same session, not a day out.
    const diffMs = new Date(r.nextReviewAt).getTime() - NOW.getTime();
    expect(diffMs).toBeGreaterThan(0);
    expect(diffMs).toBeLessThan(60 * 60 * 1000); // < 1h
  });

  it("caps at MAX_STAGE even on 'easy'", () => {
    const r = applyReview(MAX_STAGE, "easy", NOW);
    expect(r.stage).toBe(MAX_STAGE);
  });

  it("schedules the correct interval for the new stage", () => {
    const r = applyReview(2, "good", NOW);
    const diffDays =
      (new Date(r.nextReviewAt).getTime() - NOW.getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.round(diffDays)).toBe(INTERVAL_DAYS[3]);
  });
});

describe("stageLabel", () => {
  it("covers the full ladder", () => {
    expect(stageLabel(0)).toBe("New");
    expect(stageLabel(1)).toBe("Learning");
    expect(stageLabel(3)).toBe("Familiar");
    expect(stageLabel(5)).toBe("Strong");
    expect(stageLabel(MAX_STAGE)).toBe("Mastered");
  });
});
