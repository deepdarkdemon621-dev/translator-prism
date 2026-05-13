import { describe, expect, it, vi } from "vitest";
import { acquireWorkerLock } from "../lock";

function createDeps(initialLock?: string) {
  let lock = initialLock;
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const alive = new Set<number>();
  const commandLines = new Map<number, string>();

  return {
    killed,
    alive,
    commandLines,
    deps: {
      exists: vi.fn(() => lock !== undefined),
      read: vi.fn(() => lock ?? ""),
      write: vi.fn((value: string) => {
        lock = value;
      }),
      unlink: vi.fn(() => {
        lock = undefined;
      }),
      getProcessInfo: vi.fn((pid: number) => ({
        alive: alive.has(pid),
        commandLine: commandLines.get(pid),
      })),
      kill: vi.fn((pid: number, signal: NodeJS.Signals) => {
        killed.push({ pid, signal });
        alive.delete(pid);
      }),
      sleep: vi.fn(async () => {}),
    },
    getLock: () => lock,
  };
}

describe("acquireWorkerLock", () => {
  it("terminates an existing worker before taking the lock", async () => {
    const setup = createDeps("1234");
    setup.alive.add(1234);
    setup.commandLines.set(
      1234,
      "node --import file:///C:/Programming/translator/node_modules/tsx/dist/loader.mjs worker/index.ts",
    );

    await acquireWorkerLock({
      lockFile: ".worker.lock",
      currentPid: 5678,
      cwd: "C:\\Programming\\translator",
      deps: setup.deps,
    });

    expect(setup.killed).toEqual([{ pid: 1234, signal: "SIGTERM" }]);
    expect(JSON.parse(setup.getLock() ?? "{}")).toMatchObject({ pid: 5678 });
  });

  it("does not terminate a non-worker process that reused a stale pid", async () => {
    const setup = createDeps("24692");
    setup.alive.add(24692);
    setup.commandLines.set(
      24692,
      '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --type=renderer',
    );

    await acquireWorkerLock({
      lockFile: ".worker.lock",
      currentPid: 5678,
      cwd: "C:\\Programming\\translator",
      deps: setup.deps,
    });

    expect(setup.killed).toEqual([]);
    expect(JSON.parse(setup.getLock() ?? "{}")).toMatchObject({ pid: 5678 });
  });

  it("refuses to reclaim a live lock when the command line cannot be read", async () => {
    const setup = createDeps("1357");
    setup.alive.add(1357);

    await expect(
      acquireWorkerLock({
        lockFile: ".worker.lock",
        currentPid: 5678,
        cwd: "C:\\Programming\\translator",
        deps: setup.deps,
      }),
    ).rejects.toThrow(/cannot verify/i);

    expect(setup.killed).toEqual([]);
    expect(setup.getLock()).toBe("1357");
  });
});
