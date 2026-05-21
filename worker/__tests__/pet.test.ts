import { describe, expect, it, vi } from "vitest";
import {
  PET_ACTIONS,
  choosePetAction,
  getPetFrames,
  getPetMode,
  startWorkerPet,
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

describe("startWorkerPet", () => {
  it("does not write anything when disabled", () => {
    const writes: string[] = [];
    const pet = startWorkerPet({
      env: { WORKER_PET: "0" },
      isTTY: true,
      write: (value) => writes.push(value),
      setTimeoutFn: () => 1 as unknown as NodeJS.Timeout,
      clearTimeoutFn: () => {},
    });

    pet.stop();

    expect(writes).toEqual([]);
  });

  it("renders and clears a frame in animation mode", () => {
    const writes: string[] = [];
    const cleared: NodeJS.Timeout[] = [];
    const timeout = 1 as unknown as NodeJS.Timeout;
    const pet = startWorkerPet({
      env: { WORKER_PET: "1" },
      isTTY: false,
      random: () => 0,
      write: (value) => writes.push(value),
      setTimeoutFn: vi.fn(() => timeout),
      clearTimeoutFn: (handle) => cleared.push(handle),
    });

    pet.stop();

    expect(writes.join("")).toContain("( o o )");
    expect(writes.join("")).toContain("\u001b[");
    expect(cleared).toEqual([timeout]);
  });

  it("lets worker activity bias the next action", () => {
    const writes: string[] = [];
    const timers: Array<() => void> = [];
    const pet = startWorkerPet({
      env: { WORKER_PET: "1" },
      isTTY: false,
      random: () => 0,
      write: (value) => writes.push(value),
      setTimeoutFn: (callback) => {
        timers.push(callback);
        return timers.length as unknown as NodeJS.Timeout;
      },
      clearTimeoutFn: () => {},
    });

    pet.notify("working");
    timers.shift()?.();
    pet.stop();

    expect(writes.join("")).toContain("( > < )");
  });
});
