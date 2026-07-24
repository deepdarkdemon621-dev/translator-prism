import { beforeEach, describe, expect, it } from "vitest";
import { shouldClaimTranslationWork } from "../schedule";

describe("shouldClaimTranslationWork", () => {
  beforeEach(() => {
    delete process.env.WORKER_CLAUDE_WINDOW_ONLY;
    delete process.env.CLAUDE_CODE_ALLOWED_WEEKLY_WINDOW;
    delete process.env.CLAUDE_CODE_WINDOW_TZ;
  });

  it("allows work when Claude window-only mode is disabled", () => {
    process.env.CLAUDE_CODE_ALLOWED_WEEKLY_WINDOW = "FRI 18:00-SAT 10:00";
    process.env.CLAUDE_CODE_WINDOW_TZ = "Asia/Tokyo";

    expect(
      shouldClaimTranslationWork(new Date("2026-06-06T01:00:00.000Z")),
    ).toBe(true);
  });

  it("allows work inside the Claude window-only schedule", () => {
    process.env.WORKER_CLAUDE_WINDOW_ONLY = "true";
    process.env.CLAUDE_CODE_ALLOWED_WEEKLY_WINDOW = "FRI 18:00-SAT 10:00";
    process.env.CLAUDE_CODE_WINDOW_TZ = "Asia/Tokyo";

    expect(
      shouldClaimTranslationWork(new Date("2026-06-06T00:59:00.000Z")),
    ).toBe(true);
  });

  it("pauses work when the Claude window-only schedule closes", () => {
    process.env.WORKER_CLAUDE_WINDOW_ONLY = "true";
    process.env.CLAUDE_CODE_ALLOWED_WEEKLY_WINDOW = "FRI 18:00-SAT 10:00";
    process.env.CLAUDE_CODE_WINDOW_TZ = "Asia/Tokyo";

    expect(
      shouldClaimTranslationWork(new Date("2026-06-06T01:00:00.000Z")),
    ).toBe(false);
  });
});
