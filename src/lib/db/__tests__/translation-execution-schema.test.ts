import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as schema from "../schema";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

// libSQL-backed schema tests for migration 0013 (translation execution
// history). The older schema.test.ts suite uses better-sqlite3, which cannot
// build in this environment (BUG-001), so new schema coverage lives here.
describe("translation execution schema (0013)", () => {
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
    await db.delete(schema.translationAttempts).run();
    await db.delete(schema.translationRuns).run();
    await db.delete(schema.translations).run();
    await db.delete(schema.paragraphs).run();
    await db.delete(schema.chapters).run();
    await db.delete(schema.books).run();
  });

  async function seedTranslation(): Promise<string> {
    const bookId = randomUUID();
    const chapterId = randomUUID();
    const paragraphId = randomUUID();
    const translationId = randomUUID();
    await db.insert(schema.books).values({
      id: bookId,
      title: "T",
      author: "A",
      sourceLang: "ja",
      filePath: `/${bookId}.epub`,
      totalChapters: 1,
      status: "parsed",
    }).run();
    await db.insert(schema.chapters).values({
      id: chapterId,
      bookId,
      index: 0,
      title: "Ch1",
      sourceHtml: "<p>x</p>",
      status: "pending",
    }).run();
    await db.insert(schema.paragraphs).values({
      id: paragraphId,
      chapterId,
      seq: 0,
      sourceText: "テスト",
      sourceMarkup: "<p>テスト</p>",
    }).run();
    await db.insert(schema.translations).values({
      id: translationId,
      paragraphId,
      lang: "zh",
      status: "pending",
    }).run();
    return translationId;
  }

  function attemptValues(
    translationId: string,
    overrides: Partial<typeof schema.translationAttempts.$inferInsert> = {},
  ): typeof schema.translationAttempts.$inferInsert {
    return {
      id: randomUUID(),
      translationId,
      promptVersion: "v1",
      sourceHash: "abc123",
      text: "候选译文",
      status: "accepted",
      isActive: 0,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("stores lease fields on translations", async () => {
    const translationId = await seedTranslation();
    const lease = new Date(Date.now() + 60_000).toISOString();
    await db
      .update(schema.translations)
      .set({ claimedBy: "host:1:uuid", leaseExpiresAt: lease })
      .where(eq(schema.translations.id, translationId))
      .run();

    const row = await db
      .select({
        claimedBy: schema.translations.claimedBy,
        leaseExpiresAt: schema.translations.leaseExpiresAt,
      })
      .from(schema.translations)
      .where(eq(schema.translations.id, translationId))
      .get();
    expect(row).toEqual({ claimedBy: "host:1:uuid", leaseExpiresAt: lease });
  });

  it("inserts and reads a translation run", async () => {
    const runId = randomUUID();
    await db.insert(schema.translationRuns).values({
      id: runId,
      provider: "claude-code",
      model: "claude-code:sonnet",
      reasoningEffort: "high",
      promptVersion: "v1",
      workerId: "host:1:uuid",
      status: "running",
      startedAt: new Date().toISOString(),
    }).run();

    const run = await db
      .select()
      .from(schema.translationRuns)
      .where(eq(schema.translationRuns.id, runId))
      .get();
    expect(run?.provider).toBe("claude-code");
    expect(run?.status).toBe("running");
    expect(run?.claimedCount).toBe(0);
    expect(run?.doneCount).toBe(0);
    expect(run?.failedCount).toBe(0);
    expect(run?.finishedAt).toBeNull();
  });

  it("inserts a translation attempt linked to run and translation", async () => {
    const translationId = await seedTranslation();
    const runId = randomUUID();
    await db.insert(schema.translationRuns).values({
      id: runId,
      provider: "codex",
      model: "codex:gpt-5.6-sol",
      promptVersion: "v1",
      workerId: "host:1:uuid",
      status: "running",
      startedAt: new Date().toISOString(),
    }).run();

    const attemptId = randomUUID();
    await db.insert(schema.translationAttempts).values(
      attemptValues(translationId, {
        id: attemptId,
        runId,
        provider: "codex",
        model: "codex:gpt-5.6-sol",
        qualityCodes: JSON.stringify(["length_ratio"]),
        tokensUsed: 42,
        isActive: 1,
      }),
    ).run();

    const attempt = await db
      .select()
      .from(schema.translationAttempts)
      .where(eq(schema.translationAttempts.id, attemptId))
      .get();
    expect(attempt?.translationId).toBe(translationId);
    expect(attempt?.runId).toBe(runId);
    expect(attempt?.status).toBe("accepted");
    expect(attempt?.isActive).toBe(1);
    expect(attempt?.legacyTranslationId).toBeNull();
  });

  it("enforces at most one active attempt per translation", async () => {
    const translationId = await seedTranslation();
    await db.insert(schema.translationAttempts).values(
      attemptValues(translationId, { isActive: 1 }),
    ).run();

    // Drizzle wraps the libsql error; the UNIQUE constraint detail is on cause.
    const error = await db.insert(schema.translationAttempts).values(
      attemptValues(translationId, { isActive: 1 }),
    ).run().then(
      () => null,
      (err: unknown) => err as Error & { cause?: Error },
    );
    expect(error).not.toBeNull();
    expect(String(error?.cause ?? error)).toMatch(/unique/i);
  });

  it("allows many inactive attempts and active attempts across translations", async () => {
    const first = await seedTranslation();
    const second = await seedTranslation();

    await db.insert(schema.translationAttempts).values(
      attemptValues(first, { isActive: 1 }),
    ).run();
    await db.insert(schema.translationAttempts).values(
      attemptValues(first, { status: "superseded", isActive: 0 }),
    ).run();
    await db.insert(schema.translationAttempts).values(
      attemptValues(first, { status: "rejected", isActive: 0 }),
    ).run();
    await db.insert(schema.translationAttempts).values(
      attemptValues(second, { isActive: 1 }),
    ).run();

    const rows = await db.select().from(schema.translationAttempts).all();
    expect(rows).toHaveLength(4);
  });
});
