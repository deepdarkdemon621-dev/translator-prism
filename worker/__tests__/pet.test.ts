import { describe, expect, it } from "vitest";
import {
  PET_ACTIONS,
  choosePetAction,
  getPetFrames,
  getPetMode,
} from "../pet";

describe("getPetMode", () => {
  it("disables the pet when WORKER_PET is 0", () => {
    expect(getPetMode({ env: { WORKER_PET: "0" }, isTTY: true })).toBe("off");
  });

  it("force-enables animation when WORKER_PET is 1", () => {
    expect(getPetMode({ env: { WORKER_PET: "1", CI: "true" }, isTTY: false })).toBe(
      "animate",
    );
  });

  it("uses animation by default only in an interactive non-CI terminal", () => {
    expect(getPetMode({ env: {}, isTTY: true })).toBe("animate");
    expect(getPetMode({ env: {}, isTTY: false })).toBe("off");
    expect(getPetMode({ env: { CI: "true" }, isTTY: true })).toBe("off");
  });
});

describe("droplet ghost frames", () => {
  it("defines non-empty frames for every action", () => {
    for (const action of PET_ACTIONS) {
      const frames = getPetFrames(action);

      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every((frame) => frame.length > 0)).toBe(true);
      expect(frames.every((frame) => frame.includes("'~~~'"))).toBe(true);
    }
  });
});

describe("choosePetAction", () => {
  it("returns a known action using the supplied random source", () => {
    expect(choosePetAction(() => 0)).toBe("float");
    expect(PET_ACTIONS).toContain(choosePetAction(() => 0.999));
  });

  it("can bias toward working and error actions", () => {
    expect(choosePetAction(() => 0, "working")).toBe("working");
    expect(choosePetAction(() => 0, "error")).toBe("error");
  });
});
