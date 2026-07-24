import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import {
  finishTranslationRun,
  recordRunCounts,
  startTranslationRun,
} from "@/lib/translate/run-lifecycle";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

describe("translation run lifecycle", () => {
  let client: Client;
  let db: TestDb;

  beforeAll(async () => {
    client = createClient({ url: "file::memory:" });
    await migrate(drizzle(client, { schema }), { migrationsFolder: "./drizzle" });
    db = drizzle(client, { schema });
  });

  afterAll(() => {
    client.close();
  });

  beforeEach(async () => {
    await db.delete(schema.translationRuns).run();
  });

  it("starts a running run with configuration metadata", async () => {
    const runId = await startTranslationRun({
      client,
      provider: "codex",
      model: "codex:gpt-5.6-sol",
      reasoningEffort: "high",
      promptVersion: "v1",
      workerId: "host:1:x",
      now: new Date("2026-07-24T10:00:00.000Z"),
    });

    const run = await db
      .select()
      .from(schema.translationRuns)
      .where(eq(schema.translationRuns.id, runId))
      .get();
    expect(run).toMatchObject({
      provider: "codex",
      model: "codex:gpt-5.6-sol",
      reasoningEffort: "high",
      promptVersion: "v1",
      workerId: "host:1:x",
      status: "running",
      startedAt: "2026-07-24T10:00:00.000Z",
      finishedAt: null,
      claimedCount: 0,
      doneCount: 0,
      failedCount: 0,
    });
  });

  it("accumulates claimed/done/failed counters", async () => {
    const runId = await startTranslationRun({
      client,
      provider: "claude-code",
      model: "claude-code:sonnet",
      promptVersion: "v1",
      workerId: "host:1:x",
    });

    await recordRunCounts(client, runId, { claimed: 20 });
    await recordRunCounts(client, runId, { done: 18, failed: 2 });
    await recordRunCounts(client, runId, { claimed: 20, done: 20 });

    const run = await db
      .select()
      .from(schema.translationRuns)
      .where(eq(schema.translationRuns.id, runId))
      .get();
    expect(run).toMatchObject({
      claimedCount: 40,
      doneCount: 38,
      failedCount: 2,
    });
  });

  it("finishes a run with a terminal status and timestamp", async () => {
    const runId = await startTranslationRun({
      client,
      provider: "claude-code",
      model: "claude-code:sonnet",
      promptVersion: "v1",
      workerId: "host:1:x",
    });

    await finishTranslationRun(
      client,
      runId,
      "stopped",
      new Date("2026-07-24T12:00:00.000Z"),
    );

    const run = await db
      .select()
      .from(schema.translationRuns)
      .where(eq(schema.translationRuns.id, runId))
      .get();
    expect(run).toMatchObject({
      status: "stopped",
      finishedAt: "2026-07-24T12:00:00.000Z",
    });
  });
});
