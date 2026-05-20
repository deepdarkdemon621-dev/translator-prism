import { describe, expect, it } from "vitest";
import { createProgressTracker } from "../progress";

describe("createProgressTracker", () => {
  it("tracks worker-local progress without requiring global queue counts", () => {
    const progress = createProgressTracker();

    progress.claimed();
    progress.claimed();
    progress.completed("done");
    progress.completed("failed");

    expect(progress.snapshot()).toEqual({
      claimed: 2,
      done: 1,
      failed: 1,
      skipped: 0,
      inFlight: 0,
    });
  });

  it("formats the worker-local progress line", () => {
    const progress = createProgressTracker();
    progress.claimed();
    progress.completed("done");

    expect(progress.format()).toBe(
      "[worker] progress source=memory claimed=1 done=1 failed=0 skipped=0 inFlight=0",
    );
  });
});
