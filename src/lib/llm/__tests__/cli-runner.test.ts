import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCliCommand, runCli } from "../cli-runner";

describe("CLI runner", () => {
  it("returns stdout and stderr for a successful command", async () => {
    const result = await runCli({
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume(); process.stdin.on('data', d => process.stdout.write(d.toString().toUpperCase()))",
      ],
      stdin: "hello",
      timeoutMs: 5_000,
    });

    expect(result.stdout).toBe("HELLO");
    expect(result.stderr).toBe("");
  });

  it("throws stderr when a command exits non-zero", async () => {
    await expect(
      runCli({
        command: process.execPath,
        args: ["-e", "process.stderr.write('bad things'); process.exit(7)"],
        stdin: "",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("bad things");
  });

  it("kills a command that exceeds the timeout", async () => {
    await expect(
      runCli({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        stdin: "",
        timeoutMs: 50,
      }),
    ).rejects.toThrow("CLI process timed out");
  });

  it("prefers a Windows .cmd shim over .ps1", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-runner-"));
    const oldPath = process.env.PATH;
    try {
      writeFileSync(join(dir, "codex.ps1"), "");
      writeFileSync(join(dir, "codex.cmd"), "");
      process.env.PATH = `${dir};${oldPath ?? ""}`;

      expect(resolveCliCommand("codex", "win32")).toBe(join(dir, "codex.cmd"));
    } finally {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
