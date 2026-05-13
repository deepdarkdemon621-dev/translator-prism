// SINGLE-WORKER INVARIANT
// This worker is designed to run exactly once per project on the user's
// local machine, supervised by PM2. `resetStaleProcessing()` below flips
// EVERY row in 'processing' back to 'pending' on startup, which is only safe
// under that assumption. Startup lock handling stops a previous local worker
// before this process begins polling.
import { config as loadEnv } from "dotenv";
import path from "path";

// Match the migrate.ts pattern: explicit-load priority files first, then
// fallback to default .env. dotenv never overwrites existing env, so vars
// pre-injected by PM2 (via env_file) still win over file contents.
loadEnv({ path: path.join(process.cwd(), ".env.worker") });
loadEnv({ path: path.join(process.cwd(), ".env.local") });
loadEnv();

import { getLibsqlClient } from "../src/lib/db";
import { runTranslation } from "../src/lib/llm/executor";
import { acquireWorkerLock, releaseWorkerLock } from "./lock";

const POLL_INTERVAL = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 2);
const LOCK_FILE = path.join(process.cwd(), ".worker.lock");

let shuttingDown = false;
let inFlight = 0;

function requestShutdown(signal: string) {
  if (shuttingDown) return;
  console.log(`[worker] ${signal} - finishing in-flight jobs then exiting`);
  shuttingDown = true;
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("exit", () => releaseWorkerLock(LOCK_FILE));

async function claimOne(): Promise<string | null> {
  const client = getLibsqlClient();
  const now = new Date().toISOString();
  const res = await client.execute({
    sql: `UPDATE translations
          SET status = 'processing', updated_at = ?
          WHERE id = (
            SELECT id FROM translations
            WHERE status = 'pending'
            ORDER BY created_at
            LIMIT 1
          )
          RETURNING id`,
    args: [now],
  });
  const row = res.rows[0];
  return row ? (row.id as string) : null;
}

async function resetStaleProcessing(): Promise<void> {
  const client = getLibsqlClient();
  const now = new Date().toISOString();
  const res = await client.execute({
    sql: "UPDATE translations SET status='pending', updated_at=? WHERE status='processing'",
    args: [now],
  });
  if (res.rowsAffected > 0) {
    console.log(`[worker] Reset ${res.rowsAffected} stuck 'processing' rows to 'pending'`);
  }
}

async function loop() {
  await acquireWorkerLock({ lockFile: LOCK_FILE });
  await resetStaleProcessing();
  console.log(`[worker] Starting (poll=${POLL_INTERVAL}ms, concurrency=${CONCURRENCY})`);

  while (!shuttingDown) {
    if (inFlight >= CONCURRENCY) {
      await sleep(POLL_INTERVAL);
      continue;
    }
    const id = await claimOne();
    if (!id) {
      await sleep(POLL_INTERVAL);
      continue;
    }
    inFlight++;
    runTranslation(id)
      .catch((err) => console.error(`[worker] runTranslation(${id}) threw:`, err))
      .finally(() => {
        inFlight--;
      });
  }

  while (inFlight > 0) await sleep(100);
  console.log("[worker] Shutdown complete");
  process.exit(0);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

loop().catch((err) => {
  console.error("[worker] Fatal:", err);
  process.exit(1);
});
