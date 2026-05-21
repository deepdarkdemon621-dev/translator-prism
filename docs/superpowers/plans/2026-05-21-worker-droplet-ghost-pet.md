# Worker Droplet Ghost Pet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a droplet-shaped ghost pet that animates randomly in the worker terminal without interfering with worker processing or captured logs.

**Architecture:** Add an isolated `worker/pet.ts` module that owns pet frames, terminal capability checks, random action selection, and timer lifecycle. `worker/index.ts` only starts the pet near worker startup, pings optional activity events, and stops it during shutdown/fatal exits.

**Tech Stack:** TypeScript, Node.js timers and streams, Vitest, existing `tsx` worker runtime.

---

## File Structure

- Create `worker/pet.ts`: pet action frames, mode detection, renderer, timer lifecycle, and testable helpers.
- Create `worker/__tests__/pet.test.ts`: TDD coverage for environment controls, frame definitions, action selection, and renderer behavior.
- Modify `worker/index.ts`: import `startWorkerPet`, start it after lock/reset, notify activity/error events, and stop it on shutdown/fatal exit.

## Task 1: Pet Capability And Frames

**Files:**
- Create: `worker/__tests__/pet.test.ts`
- Create: `worker/pet.ts`

- [ ] **Step 1: Write the failing tests**

Add `worker/__tests__/pet.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  PET_ACTIONS,
  choosePetAction,
  getPetMode,
  getPetFrames,
  type PetAction,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run worker/__tests__/pet.test.ts
```

Expected: FAIL because `worker/pet.ts` does not exist and exports are missing.

- [ ] **Step 3: Implement minimal pet helpers and frames**

Create `worker/pet.ts`:

```ts
export const PET_ACTIONS = [
  "float",
  "blink",
  "working",
  "thinking",
  "sleep",
  "cheer",
  "error",
  "hide",
] as const;

export type PetAction = (typeof PET_ACTIONS)[number];
export type PetBias = "working" | "error";
export type PetMode = "animate" | "off";

type PetEnv = Pick<NodeJS.ProcessEnv, "WORKER_PET" | "CI">;

export function getPetMode({
  env = process.env,
  isTTY = Boolean(process.stdout.isTTY),
}: {
  env?: PetEnv;
  isTTY?: boolean;
} = {}): PetMode {
  if (env.WORKER_PET === "0") return "off";
  if (env.WORKER_PET === "1") return "animate";
  if (env.CI) return "off";
  return isTTY ? "animate" : "off";
}

const FRAMES: Record<PetAction, string[]> = {
  float: [
    "   .\n  / \\\n /   \\\n( o o )\n \\ ^ /\n  \\_/\n '~~~'",
    "    .\n   / \\\n  /   \\\n ( o o )\n  \\ ^ /\n   \\_/\n  '~~~'",
  ],
  blink: [
    "   .\n  / \\\n /   \\\n( o o )\n \\ ^ /\n  \\_/\n '~~~'",
    "   .\n  / \\\n /   \\\n( - - )\n \\ ^ /\n  \\_/\n '~~~'",
  ],
  working: [
    "   .    .\n  / \\   ..\n /   \\  ...\n( > < )\n \\ ^ /\n  \\_/\n '~~~'",
    "   .    ..\n  / \\   ...\n /   \\  .\n( > < )\n \\ - /\n  \\_/\n '~~~'",
  ],
  thinking: [
    "   ?\n   .\n  / \\\n /   \\\n( o o )\n \\ ? /\n  \\_/\n '~~~'",
  ],
  sleep: [
    "   z\n   .\n  / \\\n /   \\\n( - - )\n \\ _ /\n  \\_/\n '~~~'",
  ],
  cheer: [
    " \\ . /\n  / \\\n /   \\\n( ^ ^ )\n \\ v /\n  \\_/\n '~~~'",
  ],
  error: [
    "   !\n   .\n  / \\\n /   \\\n( ! ! )\n \\ o /\n  \\_/\n '~~~'",
    "  !\n  .\n / \\\n/   \\\n( ! ! )\n\\ o /\n \\_/\n'~~~'",
  ],
  hide: [
    "   .\n  / \\\n ( - - )\n  \\_/\n '~~~'",
    "   .\n  / \\\n /   \\\n( o o )\n \\ ^ /\n  \\_/\n '~~~'",
  ],
};

export function getPetFrames(action: PetAction): string[] {
  return FRAMES[action];
}

export function choosePetAction(
  random: () => number = Math.random,
  bias?: PetBias,
): PetAction {
  if (bias === "working" && random() < 0.5) return "working";
  if (bias === "error" && random() < 0.7) return "error";
  const index = Math.min(Math.floor(random() * PET_ACTIONS.length), PET_ACTIONS.length - 1);
  return PET_ACTIONS[index];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run worker/__tests__/pet.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/pet.ts worker/__tests__/pet.test.ts
git commit -m "feat(worker): add droplet ghost pet frames"
```

## Task 2: Animated Renderer Lifecycle

**Files:**
- Modify: `worker/__tests__/pet.test.ts`
- Modify: `worker/pet.ts`

- [ ] **Step 1: Write the failing renderer tests**

Append to `worker/__tests__/pet.test.ts`:

```ts
import { vi } from "vitest";
import { startWorkerPet } from "../pet";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run worker/__tests__/pet.test.ts
```

Expected: FAIL because `startWorkerPet` is not exported.

- [ ] **Step 3: Implement renderer lifecycle**

Extend `worker/pet.ts` with:

```ts
export type WorkerPetEvent = "working" | "error";

export interface WorkerPet {
  notify(event: WorkerPetEvent): void;
  stop(): void;
}

interface StartWorkerPetOptions {
  env?: PetEnv;
  isTTY?: boolean;
  random?: () => number;
  write?: (value: string) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

const FRAME_INTERVAL_MS = 240;
const ACTION_DELAY_MIN_MS = 3_000;
const ACTION_DELAY_SPREAD_MS = 5_000;

export function startWorkerPet({
  env = process.env,
  isTTY = Boolean(process.stdout.isTTY),
  random = Math.random,
  write = (value) => process.stdout.write(value),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}: StartWorkerPetOptions = {}): WorkerPet {
  if (getPetMode({ env, isTTY }) === "off") {
    return { notify() {}, stop() {} };
  }

  let stopped = false;
  let handle: NodeJS.Timeout | undefined;
  let linesDrawn = 0;
  let bias: PetBias | undefined;

  const clear = () => {
    if (linesDrawn === 0) return;
    write(`\u001b[${linesDrawn}A\u001b[J`);
    linesDrawn = 0;
  };

  const render = (frame: string) => {
    clear();
    const output = `[worker-pet]\n${frame}\n`;
    write(output);
    linesDrawn = output.split("\n").length - 1;
  };

  const schedule = (delay: number) => {
    handle = setTimeoutFn(runAction, delay);
  };

  const runFrame = (frames: string[], index: number) => {
    if (stopped) return;
    render(frames[index]);
    if (index + 1 < frames.length) {
      handle = setTimeoutFn(() => runFrame(frames, index + 1), FRAME_INTERVAL_MS);
      return;
    }
    const nextDelay = ACTION_DELAY_MIN_MS + Math.floor(random() * ACTION_DELAY_SPREAD_MS);
    schedule(nextDelay);
  };

  const runAction = () => {
    if (stopped) return;
    const action = choosePetAction(random, bias);
    bias = undefined;
    runFrame(getPetFrames(action), 0);
  };

  try {
    runAction();
  } catch {
    stopped = true;
  }

  return {
    notify(event) {
      bias = event;
    },
    stop() {
      stopped = true;
      if (handle) clearTimeoutFn(handle);
      try {
        clear();
      } catch {
        // Pet rendering must never affect worker shutdown.
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run worker/__tests__/pet.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/pet.ts worker/__tests__/pet.test.ts
git commit -m "feat(worker): animate terminal pet"
```

## Task 3: Worker Integration

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Write a failing static integration test**

Append to `worker/__tests__/pet.test.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";

describe("worker pet integration", () => {
  it("starts, notifies, and stops the pet from the worker entrypoint", () => {
    const entrypoint = readFileSync(path.join(process.cwd(), "worker/index.ts"), "utf8");

    expect(entrypoint).toContain('import { startWorkerPet');
    expect(entrypoint).toContain("const workerPet = startWorkerPet()");
    expect(entrypoint).toContain('workerPet.notify("working")');
    expect(entrypoint).toContain('workerPet.notify("error")');
    expect(entrypoint).toContain("workerPet.stop()");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run worker/__tests__/pet.test.ts
```

Expected: FAIL because `worker/index.ts` does not import or call the pet.

- [ ] **Step 3: Integrate the pet into worker startup and lifecycle**

Modify `worker/index.ts`:

```ts
import { startWorkerPet, type WorkerPet } from "./pet";
```

Add near existing globals:

```ts
let workerPet: WorkerPet | undefined;
```

Update `requestShutdown`:

```ts
function requestShutdown(signal: string) {
  if (shuttingDown) return;
  console.log(`[worker] ${signal} - finishing in-flight jobs then exiting`);
  shuttingDown = true;
  workerPet?.stop();
}
```

Start after the existing startup log:

```ts
  console.log(`[worker] Starting (poll=${POLL_INTERVAL}ms, concurrency=${CONCURRENCY}, progressLog=${PROGRESS_LOG_INTERVAL}ms)`);
  workerPet = startWorkerPet();
```

Notify when work is claimed:

```ts
    finalProgressLogged = false;
    workerPet?.notify("working");
    inFlight++;
```

Notify on translation failure:

```ts
      .catch((err) => {
        progress.completed("failed");
        workerPet?.notify("error");
        console.error(`[worker] runTranslation(${id}) threw:`, err);
      })
```

Stop before normal exit:

```ts
  console.log("[worker] Shutdown complete");
  workerPet?.stop();
  process.exit(0);
```

Stop before fatal exit:

```ts
loop().catch((err) => {
  workerPet?.stop();
  console.error("[worker] Fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run worker/__tests__/pet.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/index.ts worker/__tests__/pet.test.ts
git commit -m "feat(worker): start terminal pet with worker"
```

## Task 4: Final Verification

**Files:**
- Review: `worker/pet.ts`
- Review: `worker/index.ts`
- Review: `worker/__tests__/pet.test.ts`

- [ ] **Step 1: Run focused worker tests**

Run:

```bash
npx vitest run worker/__tests__/pet.test.ts worker/__tests__/progress.test.ts worker/__tests__/lock.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run type/lint verification**

Run:

```bash
npx tsc --noEmit
npm run lint
```

Expected: both commands exit 0.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git status --short
git diff --stat HEAD
```

Expected: only worker pet implementation and tests are uncommitted if commits were intentionally skipped; otherwise working tree is clean.

- [ ] **Step 5: Final commit if needed**

If there are uncommitted implementation changes:

```bash
git add worker/pet.ts worker/index.ts worker/__tests__/pet.test.ts
git commit -m "feat(worker): add animated droplet ghost pet"
```
