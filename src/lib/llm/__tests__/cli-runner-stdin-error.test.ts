import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("CLI runner stdin errors", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      spawn: vi.fn(() => createChildThatClosesBeforeStdinIsConsumed()),
    }));
  });

  it("ignores stdin pipe errors and lets process close determine the result", async () => {
    const { runCli } = await import("../cli-runner");

    await expect(
      runCli({
        command: "fake-cli",
        args: [],
        stdin: "long prompt",
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ stdout: "", stderr: "" });
  });
});

function createChildThatClosesBeforeStdinIsConsumed() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: () => void };
    stderr: EventEmitter & { setEncoding: () => void };
    stdin: EventEmitter & { write: () => void; end: () => void };
    kill: () => void;
  };

  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.stdin = Object.assign(new EventEmitter(), {
    write() {
      if (this.listenerCount("error") === 0) {
        throw new Error("unhandled stdin error");
      }
      this.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
    },
    end() {
      queueMicrotask(() => child.emit("close", 0));
    },
  });
  child.kill = () => {};

  return child;
}
