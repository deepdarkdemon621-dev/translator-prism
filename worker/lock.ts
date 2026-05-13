import { execFileSync } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";

interface ProcessInfo {
  alive: boolean;
  commandLine?: string;
}

export interface WorkerLockDeps {
  exists: () => boolean;
  read: () => string;
  write: (value: string) => void;
  unlink: () => void;
  getProcessInfo: (pid: number) => ProcessInfo;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
}

interface AcquireWorkerLockOptions {
  lockFile: string;
  currentPid?: number;
  cwd?: string;
  shutdownTimeoutMs?: number;
  pollIntervalMs?: number;
  deps?: WorkerLockDeps;
}

interface ParsedLock {
  pid: number;
}

export async function acquireWorkerLock({
  lockFile,
  currentPid = process.pid,
  cwd = process.cwd(),
  shutdownTimeoutMs = 15_000,
  pollIntervalMs = 250,
  deps = createDefaultDeps(lockFile),
}: AcquireWorkerLockOptions): Promise<void> {
  if (deps.exists()) {
    const lock = parseLock(deps.read());
    if (lock?.pid && lock.pid !== currentPid) {
      await handleExistingLock(lock.pid, {
        cwd,
        shutdownTimeoutMs,
        pollIntervalMs,
        deps,
      });
    }
  }

  deps.write(JSON.stringify({ pid: currentPid, cwd, startedAt: new Date().toISOString() }));
}

export function releaseWorkerLock(
  lockFile: string,
  currentPid = process.pid,
  deps = createDefaultDeps(lockFile),
): void {
  try {
    if (!deps.exists()) return;
    const lock = parseLock(deps.read());
    if (lock?.pid === currentPid) deps.unlink();
  } catch {
    // best effort
  }
}

async function handleExistingLock(
  existingPid: number,
  options: {
    cwd: string;
    shutdownTimeoutMs: number;
    pollIntervalMs: number;
    deps: WorkerLockDeps;
  },
) {
  const { cwd, shutdownTimeoutMs, pollIntervalMs, deps } = options;
  const info = deps.getProcessInfo(existingPid);
  if (!info.alive) {
    console.warn(`[worker] Stale lock from dead PID ${existingPid} - reclaiming.`);
    return;
  }

  if (!isWorkerCommand(info.commandLine, cwd)) {
    console.warn(
      `[worker] Lock PID ${existingPid} is alive but is not this worker - reclaiming stale lock.`,
    );
    return;
  }

  console.warn(`[worker] Existing worker PID ${existingPid} is running - stopping it first.`);
  deps.kill(existingPid, "SIGTERM");

  if (await waitForExit(existingPid, shutdownTimeoutMs, pollIntervalMs, deps)) return;

  console.warn(`[worker] Existing worker PID ${existingPid} did not exit - forcing stop.`);
  deps.kill(existingPid, "SIGKILL");
  await waitForExit(existingPid, 2_000, pollIntervalMs, deps);
}

async function waitForExit(
  pid: number,
  timeoutMs: number,
  pollIntervalMs: number,
  deps: WorkerLockDeps,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await deps.sleep(pollIntervalMs);
    if (!deps.getProcessInfo(pid).alive) return true;
  }
  return false;
}

function parseLock(raw: string): ParsedLock | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const legacyPid = Number(trimmed);
  if (Number.isInteger(legacyPid) && legacyPid > 0) return { pid: legacyPid };

  try {
    const parsed = JSON.parse(trimmed) as { pid?: unknown };
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return { pid: parsed.pid };
    }
  } catch {
    // handled below
  }

  return null;
}

function isWorkerCommand(commandLine: string | undefined, cwd: string): boolean {
  if (!commandLine) return false;
  const normalizedCommand = normalizePath(commandLine);
  const normalizedCwd = normalizePath(cwd);

  return (
    normalizedCommand.includes("worker/index.ts") &&
    (!normalizedCwd || normalizedCommand.includes(normalizedCwd))
  );
}

function createDefaultDeps(lockFile: string): WorkerLockDeps {
  return {
    exists: () => existsSync(lockFile),
    read: () => readFileSync(lockFile, "utf8"),
    write: (value) => writeFileSync(lockFile, value),
    unlink: () => unlinkSync(lockFile),
    getProcessInfo: getProcessInfo,
    kill: (pid, signal) => process.kill(pid, signal),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function getProcessInfo(pid: number): ProcessInfo {
  try {
    process.kill(pid, 0);
  } catch {
    return { alive: false };
  }

  return { alive: true, commandLine: readCommandLine(pid) };
}

function readCommandLine(pid: number): string | undefined {
  try {
    if (process.platform === "win32") {
      return execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
        ],
        { encoding: "utf8", windowsHide: true },
      ).trim();
    }

    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return undefined;
  }
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}
