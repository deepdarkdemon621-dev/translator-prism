// SINGLE-WORKER INVARIANT (operational)
// This worker is designed to run once per project on the user's local
// machine, supervised by PM2. Claims are lease-based (ARCH-002): a
// 'processing' row can only be reclaimed after its lease expires, so a
// crashed worker's rows recover on their own without the old full-table
// processing reset, and a second worker can no longer steal live work.
// Operationally we still run exactly one worker; startup lock handling stops
// a previous local worker before this process begins polling.
import { config as loadEnv } from "dotenv";
import path from "path";

// Match the migrate.ts pattern: explicit-load priority files first, then
// fallback to default .env. dotenv never overwrites existing env, so vars
// pre-injected by PM2 (via env_file) still win over file contents.
loadEnv({ path: path.join(process.cwd(), ".env.worker") });
loadEnv({ path: path.join(process.cwd(), ".env.local") });
loadEnv();

import { getLibsqlClient } from "../src/lib/db";
import { CHAPTER_BATCH_PROMPT_VERSION } from "../src/lib/llm/cli-providers";
import { getConfiguredProvider } from "../src/lib/llm/executor";
import { runClaimedTranslationBatch } from "../src/lib/translate/run-claimed-batch";
import {
  finishTranslationRun,
  recordRunCounts,
  startTranslationRun,
} from "../src/lib/translate/run-lifecycle";
import {
  claimTranslationBatch,
  makeWorkerId,
  startLeaseHeartbeat,
} from "./claim";
import { acquireWorkerLock, releaseWorkerLock } from "./lock";
import { requeueEligibleFailedTranslations } from "./failed-requeue";
import { startWorkerPet, type WorkerPet } from "./pet";
import { createProgressTracker } from "./progress";
import { runRecoverableWorkerStep } from "./resilience";
import { shouldClaimTranslationWork } from "./schedule";

const POLL_INTERVAL = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 2);
const BATCH_SIZE = Math.max(1, Number(process.env.WORKER_BATCH_SIZE ?? 1));
const BATCH_MAX_CHARS = process.env.WORKER_BATCH_MAX_CHARS
  ? Math.max(1, Number(process.env.WORKER_BATCH_MAX_CHARS))
  : undefined;
const LEASE_MS = Number(process.env.WORKER_LEASE_MS ?? 600_000);
const LEASE_HEARTBEAT_MS = Number(process.env.WORKER_LEASE_HEARTBEAT_MS ?? 60_000);
const PROGRESS_LOG_INTERVAL = Number(process.env.WORKER_PROGRESS_LOG_INTERVAL_MS ?? 300_000);
const RECOVERABLE_ERROR_RETRY_DELAY = Number(
  process.env.WORKER_RECOVERABLE_ERROR_RETRY_DELAY_MS ?? 30_000,
);
const REQUEUE_FAILED_WHEN_IDLE = process.env.WORKER_REQUEUE_FAILED_WHEN_IDLE === "true";
const FAILED_RETRY_LIMIT = Number(process.env.WORKER_FAILED_RETRY_LIMIT ?? 2);
const FAILED_RETRY_BATCH_SIZE = Number(process.env.WORKER_FAILED_RETRY_BATCH_SIZE ?? 500);
const LOCK_FILE = path.join(process.cwd(), ".worker.lock");

const workerId = makeWorkerId();
let shuttingDown = false;
let inFlight = 0;
let lastProgressLog = Date.now();
let finalProgressLogged = false;
const progress = createProgressTracker();
let workerPet: WorkerPet | undefined;
let pauseLogged = false;
let runId: string | null = null;
let stopLeaseHeartbeat: (() => void) | null = null;
const inFlightIds = new Set<string>();

function requestShutdown(signal: string) {
  if (shuttingDown) return;
  console.log(`[worker] ${signal} - finishing in-flight jobs then exiting`);
  shuttingDown = true;
  workerPet?.stop();
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("exit", () => releaseWorkerLock(LOCK_FILE));

async function getStatusCounts(): Promise<Record<string, number>> {
  const client = getLibsqlClient();
  const res = await client.execute(
    "SELECT status, COUNT(*) c FROM translations GROUP BY status",
  );
  return Object.fromEntries(res.rows.map((row) => [String(row.status), Number(row.c)]));
}

function formatStatusCounts(prefix: string, counts: Record<string, number>): string {
  return `${prefix} source=turso done=${counts.done ?? 0} pending=${counts.pending ?? 0} processing=${counts.processing ?? 0} failed=${counts.failed ?? 0}`;
}

function logMemoryProgress(force = false): void {
  const now = Date.now();
  if (!force && now - lastProgressLog < PROGRESS_LOG_INTERVAL) return;
  console.log(progress.format());
  lastProgressLog = now;
}

async function logFinalProgress(): Promise<void> {
  const counts = await getStatusCounts();
  console.log(formatStatusCounts("[worker] final progress", counts));
}

// Run row metadata comes from env config; the actual model per result row is
// still recorded on translations/attempts by the persistence layer.
function describeRunConfig(): {
  provider: string;
  model: string;
  reasoningEffort: string | null;
} {
  const chain = (process.env.TRANSLATION_PROVIDER_CHAIN ?? "").trim();
  const models: string[] = [];
  if (chain.includes("claude-code")) {
    models.push(`claude-code:${process.env.CLAUDE_CODE_MODEL || "sonnet"}`);
  }
  if (chain.includes("codex")) {
    models.push(`codex:${process.env.CODEX_CLI_MODEL || "default"}`);
  }
  return {
    provider: chain || "settings-default",
    model: models.join(",") || "settings-default",
    reasoningEffort: process.env.CODEX_CLI_REASONING_EFFORT ?? null,
  };
}

function logRecoverableWorkerError(
  label: string,
  err: unknown,
  retryDelayMs: number,
): void {
  workerPet?.notify("error");
  console.warn(
    `[worker] Recoverable infrastructure error during ${label}; retrying in ${retryDelayMs}ms:`,
    err,
  );
}

async function runRecoverableStep<T>(
  label: string,
  operation: () => Promise<T>,
) {
  return runRecoverableWorkerStep({
    label,
    operation,
    onRecoverableError: logRecoverableWorkerError,
    retryDelayMs: RECOVERABLE_ERROR_RETRY_DELAY,
    sleep,
  });
}

async function loop() {
  await acquireWorkerLock({ lockFile: LOCK_FILE });
  const client = getLibsqlClient();
  const runConfig = describeRunConfig();

  while (!shuttingDown) {
    const runStart = await runRecoverableStep("startTranslationRun", () =>
      startTranslationRun({
        client,
        provider: runConfig.provider,
        model: runConfig.model,
        reasoningEffort: runConfig.reasoningEffort,
        promptVersion: CHAPTER_BATCH_PROMPT_VERSION,
        workerId,
      }),
    );
    if (runStart.ok) {
      runId = runStart.value;
      break;
    }
  }

  console.log(
    `[worker] Starting (worker=${workerId}, run=${runId}, poll=${POLL_INTERVAL}ms, concurrency=${CONCURRENCY}, batchSize=${BATCH_SIZE}, maxChars=${BATCH_MAX_CHARS ?? "∞"}, leaseMs=${LEASE_MS}, progressLog=${PROGRESS_LOG_INTERVAL}ms)`,
  );
  stopLeaseHeartbeat = startLeaseHeartbeat({
    client,
    workerId,
    leaseMs: LEASE_MS,
    intervalMs: LEASE_HEARTBEAT_MS,
    getTranslationIds: () => [...inFlightIds],
    onError: (err) => console.warn("[worker] lease heartbeat failed:", err),
  });
  workerPet = startWorkerPet();

  while (!shuttingDown) {
    logMemoryProgress();
    if (!shouldClaimTranslationWork()) {
      if (!pauseLogged) {
        console.log(
          "[worker] Claude window-only mode is outside the allowed window; pausing new claims",
        );
        pauseLogged = true;
      }
      await sleep(POLL_INTERVAL);
      continue;
    }
    if (pauseLogged) {
      console.log("[worker] Claude window reopened; resuming claims");
      pauseLogged = false;
    }
    if (inFlight >= CONCURRENCY) {
      await sleep(POLL_INTERVAL);
      continue;
    }
    const claimResult = await runRecoverableStep("claimTranslationBatch", () =>
      claimTranslationBatch({
        client,
        workerId,
        batchSize: BATCH_SIZE,
        maxChars: BATCH_MAX_CHARS,
        leaseMs: LEASE_MS,
      }),
    );
    if (!claimResult.ok) continue;
    const batch = claimResult.value;
    if (!batch || batch.items.length === 0) {
      if (inFlight === 0 && !finalProgressLogged) {
        const finalProgressResult = await runRecoverableStep(
          "logFinalProgress",
          logFinalProgress,
        );
        if (!finalProgressResult.ok) continue;
        finalProgressLogged = true;

        if (REQUEUE_FAILED_WHEN_IDLE) {
          const requeueResult = await runRecoverableStep(
            "requeueEligibleFailed",
            () =>
              requeueEligibleFailedTranslations({
                retryLimit: FAILED_RETRY_LIMIT,
                batchSize: FAILED_RETRY_BATCH_SIZE,
              }),
          );
          if (!requeueResult.ok) continue;
          if (requeueResult.value > 0) {
            console.log(
              `[worker] Requeued ${requeueResult.value} failed rows for retry`,
            );
            finalProgressLogged = false;
            continue;
          }
        }
      }
      await sleep(POLL_INTERVAL);
      continue;
    }
    finalProgressLogged = false;
    workerPet?.notify("working");
    inFlight++;
    const ids = batch.items.map((item) => item.translationId);
    for (const id of ids) {
      inFlightIds.add(id);
      progress.claimed();
    }
    if (runId) {
      recordRunCounts(client, runId, { claimed: ids.length }).catch(() => {});
    }

    (async () => {
      const provider = await getConfiguredProvider();
      return runClaimedTranslationBatch({
        client,
        provider,
        batch,
        workerId,
        runId,
        promptVersion: CHAPTER_BATCH_PROMPT_VERSION,
        reasoningEffort: runConfig.reasoningEffort,
      });
    })()
      .then((counts) => {
        for (let i = 0; i < counts.done; i++) progress.completed("done");
        for (let i = 0; i < counts.failed; i++) progress.completed("failed");
        const untracked = counts.skipped + counts.released;
        for (let i = 0; i < untracked; i++) progress.completed("skipped");
        if (counts.released > 0) {
          console.log(
            `[worker] Released ${counts.released} unanswered item(s) back to pending`,
          );
        }
        if (runId) {
          recordRunCounts(client, runId, {
            done: counts.done,
            failed: counts.failed,
          }).catch(() => {});
        }
      })
      .catch((err) => {
        for (let i = 0; i < ids.length; i++) progress.completed("failed");
        workerPet?.notify("error");
        console.error(
          `[worker] batch(chapter=${batch.chapterId}, lang=${batch.lang}, items=${ids.length}) threw:`,
          err,
        );
      })
      .finally(() => {
        for (const id of ids) inFlightIds.delete(id);
        inFlight--;
      });
  }

  while (inFlight > 0) await sleep(100);
  stopLeaseHeartbeat?.();
  if (runId) {
    // Unfinished leases (none normally at this point) simply expire.
    await finishTranslationRun(client, runId, "stopped").catch((err) =>
      console.warn("[worker] failed to close translation run:", err),
    );
  }
  console.log("[worker] Shutdown complete");
  workerPet?.stop();
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

loop().catch(async (err) => {
  workerPet?.stop();
  stopLeaseHeartbeat?.();
  console.error("[worker] Fatal:", err);
  if (runId) {
    await finishTranslationRun(getLibsqlClient(), runId, "failed").catch(() => {});
  }
  process.exit(1);
});
