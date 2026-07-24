import type { Client } from "@libsql/client";
import { randomUUID } from "crypto";

// Run history (ARCH-002): one translation_runs row per authorized worker
// process. No prompt bodies, source text, or translated text belong in run
// records or logs — configuration and counters only.

export interface StartRunOptions {
  client: Client;
  provider: string;
  model: string;
  reasoningEffort?: string | null;
  promptVersion: string;
  workerId: string;
  now?: Date;
}

export async function startTranslationRun(opts: StartRunOptions): Promise<string> {
  const id = randomUUID();
  await opts.client.execute({
    sql: `INSERT INTO translation_runs
            (id, provider, model, reasoning_effort, prompt_version, worker_id,
             status, started_at)
          VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
    args: [
      id,
      opts.provider,
      opts.model,
      opts.reasoningEffort ?? null,
      opts.promptVersion,
      opts.workerId,
      (opts.now ?? new Date()).toISOString(),
    ],
  });
  return id;
}

export interface RunCountDeltas {
  claimed?: number;
  done?: number;
  failed?: number;
}

export async function recordRunCounts(
  client: Client,
  runId: string,
  deltas: RunCountDeltas,
): Promise<void> {
  await client.execute({
    sql: `UPDATE translation_runs
          SET claimed_count = claimed_count + ?,
              done_count = done_count + ?,
              failed_count = failed_count + ?
          WHERE id = ?`,
    args: [deltas.claimed ?? 0, deltas.done ?? 0, deltas.failed ?? 0, runId],
  });
}

export type RunTerminalStatus = "stopped" | "completed" | "failed";

export async function finishTranslationRun(
  client: Client,
  runId: string,
  status: RunTerminalStatus,
  now?: Date,
): Promise<void> {
  await client.execute({
    sql: "UPDATE translation_runs SET status = ?, finished_at = ? WHERE id = ?",
    args: [status, (now ?? new Date()).toISOString(), runId],
  });
}
