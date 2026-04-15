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

const POLL_INTERVAL = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 2);

let shuttingDown = false;
let inFlight = 0;

function requestShutdown(signal: string) {
  if (shuttingDown) return;
  console.log(`[worker] ${signal} — finishing in-flight jobs then exiting`);
  shuttingDown = true;
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
// PM2 sends SIGINT then SIGKILL by default, but defending against SIGTERM
// (Docker, kill default) is essentially free and keeps shutdown graceful.
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

async function claimOne(): Promise<string | null> {
  const client = getLibsqlClient();
  const now = new Date().toISOString();
  // Atomic claim: subquery picks the oldest pending row, outer UPDATE flips
  // it to processing in the same statement. RETURNING gives us the id back.
  // libsql/SQLite serializes writes so two workers can't both grab the same
  // row even when polling concurrently.
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
  // Previous-run cleanup: any row left in 'processing' belongs to a worker
  // that died mid-job. Flip them back so this run can pick them up.
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
  return new Promise((r) => setTimeout(r, ms));
}

loop().catch((err) => {
  console.error("[worker] Fatal:", err);
  process.exit(1);
});
