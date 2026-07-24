import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as schema from "@/lib/db/schema";
import { sourceHash } from "@/lib/translate/source-hash";
import { persistTranslationBatch } from "@/lib/translate/persist-batch";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const WORKER = "host:1:worker-a";

describe("persistTranslationBatch", () => {
  let client: Client;
  let db: TestDb;
  let batchCalls: number;
  let countingClient: Client;

  beforeAll(async () => {
    client = createClient({ url: "file::memory:" });
    await migrate(drizzle(client, { schema }), { migrationsFolder: "./drizzle" });
    db = drizzle(client, { schema });
    countingClient = new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return (...args: Parameters<Client["batch"]>) => {
            batchCalls++;
            return target.batch(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  });

  afterAll(() => {
    client.close();
  });

  beforeEach(async () => {
    batchCalls = 0;
    await db.delete(schema.translationAttempts).run();
    await db.delete(schema.translationRuns).run();
    await db.delete(schema.translations).run();
    await db.delete(schema.paragraphs).run();
    await db.delete(schema.chapters).run();
    await db.delete(schema.books).run();
  });

  async function seedClaimedTranslation(overrides: {
    sourceText?: string;
    claimedBy?: string | null;
    status?: string;
  } = {}): Promise<{ translationId: string; paragraphId: string }> {
    const bookId = randomUUID();
    const chapterId = randomUUID();
    const paragraphId = randomUUID();
    const translationId = randomUUID();
    const sourceText = overrides.sourceText ?? "彼は静かに頷いた。";
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
      title: "Ch",
      sourceHtml: "<p>x</p>",
      status: "translating",
    }).run();
    await db.insert(schema.paragraphs).values({
      id: paragraphId,
      chapterId,
      seq: 0,
      sourceText,
      sourceMarkup: `<p>${sourceText}</p>`,
    }).run();
    await db.insert(schema.translations).values({
      id: translationId,
      paragraphId,
      lang: "zh",
      status: overrides.status ?? "processing",
      claimedBy:
        overrides.claimedBy === undefined ? WORKER : overrides.claimedBy,
      leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    }).run();
    return { translationId, paragraphId };
  }

  const acceptedItem = (
    translationId: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    translationId,
    sourceText: "彼は静かに頷いた。",
    text: "他静静地点了点头。",
    model: "claude-code:sonnet",
    provider: "claude-code",
    tokensUsed: 42,
    warnings: [] as string[],
    ...overrides,
  });

  const basePersist = (overrides: Record<string, unknown> = {}) => ({
    client: countingClient,
    workerId: WORKER,
    runId: null,
    promptVersion: "v1",
    accepted: [] as ReturnType<typeof acceptedItem>[],
    failed: [] as unknown[],
    ...overrides,
  });

  it("commits an accepted item atomically: canonical row, active attempt, cleared lease", async () => {
    const { translationId } = await seedClaimedTranslation();
    const result = await persistTranslationBatch(
      basePersist({ accepted: [acceptedItem(translationId)] }),
    );

    expect(result.committedDone).toEqual([translationId]);
    expect(batchCalls).toBe(1);

    const row = await db
      .select()
      .from(schema.translations)
      .where(eq(schema.translations.id, translationId))
      .get();
    expect(row).toMatchObject({
      text: "他静静地点了点头。",
      status: "done",
      model: "claude-code:sonnet",
      tokensUsed: 42,
      lastProvider: "claude-code",
      errorMessage: null,
      lastErrorCode: null,
      claimedBy: null,
      leaseExpiresAt: null,
    });

    const attempts = await db.select().from(schema.translationAttempts).all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      translationId,
      status: "accepted",
      isActive: 1,
      text: "他静静地点了点头。",
      sourceHash: sourceHash("彼は静かに頷いた。"),
      promptVersion: "v1",
    });
  });

  it("supersedes the prior active attempt", async () => {
    const { translationId } = await seedClaimedTranslation();
    await db.insert(schema.translationAttempts).values({
      id: randomUUID(),
      translationId,
      promptVersion: "v0",
      sourceHash: "old",
      text: "旧译文",
      status: "accepted",
      isActive: 1,
      createdAt: new Date().toISOString(),
    }).run();

    await persistTranslationBatch(
      basePersist({ accepted: [acceptedItem(translationId)] }),
    );

    const attempts = await db
      .select()
      .from(schema.translationAttempts)
      .where(eq(schema.translationAttempts.translationId, translationId))
      .all();
    expect(attempts).toHaveLength(2);
    const old = attempts.find((a) => a.promptVersion === "v0");
    const fresh = attempts.find((a) => a.promptVersion === "v1");
    expect(old).toMatchObject({ isActive: 0, status: "superseded" });
    expect(fresh).toMatchObject({ isActive: 1, status: "accepted" });
  });

  it("records rejected items without touching canonical text", async () => {
    const { translationId } = await seedClaimedTranslation();
    const result = await persistTranslationBatch(
      basePersist({
        failed: [
          {
            translationId,
            sourceText: "彼は静かに頷いた。",
            candidateText: "```他点头```",
            reasons: ["markdown_fence"],
            attemptStatus: "rejected",
            errorCode: "invalid_output",
            errorMessage: "[invalid_output] rejected: markdown_fence",
            provider: "claude-code",
            model: "claude-code:sonnet",
          },
        ],
      }),
    );

    expect(result.committedFailed).toEqual([translationId]);
    const row = await db
      .select()
      .from(schema.translations)
      .where(eq(schema.translations.id, translationId))
      .get();
    expect(row).toMatchObject({
      status: "failed",
      text: "",
      lastErrorCode: "invalid_output",
      claimedBy: null,
      leaseExpiresAt: null,
    });

    const attempts = await db.select().from(schema.translationAttempts).all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: "rejected",
      isActive: 0,
      text: "```他点头```",
      qualityCodes: JSON.stringify(["markdown_fence"]),
    });
  });

  it("skips commits when the source hash is stale", async () => {
    const { translationId, paragraphId } = await seedClaimedTranslation();
    await db
      .update(schema.paragraphs)
      .set({ sourceText: "改稿された原文" })
      .where(eq(schema.paragraphs.id, paragraphId))
      .run();

    const result = await persistTranslationBatch(
      basePersist({ accepted: [acceptedItem(translationId)] }),
    );

    expect(result.committedDone).toEqual([]);
    expect(result.skipped).toEqual([translationId]);
    const row = await db
      .select()
      .from(schema.translations)
      .where(eq(schema.translations.id, translationId))
      .get();
    expect(row?.status).toBe("processing");
    expect(row?.claimedBy).toBe(WORKER);
    expect(await db.select().from(schema.translationAttempts).all()).toEqual([]);
  });

  it("skips failed commits when the source hash is stale", async () => {
    const { translationId, paragraphId } = await seedClaimedTranslation();
    await db
      .update(schema.paragraphs)
      .set({ sourceText: "改稿された原文" })
      .where(eq(schema.paragraphs.id, paragraphId))
      .run();

    const result = await persistTranslationBatch(
      basePersist({
        failed: [
          {
            translationId,
            sourceText: "彼は静かに頷いた。",
            candidateText: "旧原文に対する候補",
            reasons: ["residual_source_script"],
            attemptStatus: "rejected",
            errorCode: "invalid_output",
            errorMessage: "[invalid_output] rejected: residual_source_script",
            provider: "claude-code",
            model: "claude-code:sonnet",
          },
        ],
      }),
    );

    expect(result.committedFailed).toEqual([]);
    expect(result.skipped).toEqual([translationId]);
    const row = await db
      .select()
      .from(schema.translations)
      .where(eq(schema.translations.id, translationId))
      .get();
    expect(row?.status).toBe("processing");
    expect(row?.claimedBy).toBe(WORKER);
    expect(await db.select().from(schema.translationAttempts).all()).toEqual([]);
  });

  it("skips commits from a worker that no longer owns the lease", async () => {
    const { translationId } = await seedClaimedTranslation({
      claimedBy: "other:9:z",
    });
    const result = await persistTranslationBatch(
      basePersist({ accepted: [acceptedItem(translationId)] }),
    );
    expect(result.committedDone).toEqual([]);
    expect(result.skipped).toEqual([translationId]);
    const row = await db
      .select()
      .from(schema.translations)
      .where(eq(schema.translations.id, translationId))
      .get();
    expect(row?.claimedBy).toBe("other:9:z");
    expect(row?.text).toBe("");
  });

  it("skips rows cancelled mid-flight", async () => {
    const { translationId } = await seedClaimedTranslation({ status: "cancelled" });
    const result = await persistTranslationBatch(
      basePersist({ accepted: [acceptedItem(translationId)] }),
    );
    expect(result.skipped).toEqual([translationId]);
    const row = await db
      .select()
      .from(schema.translations)
      .where(eq(schema.translations.id, translationId))
      .get();
    expect(row?.status).toBe("cancelled");
    expect(await db.select().from(schema.translationAttempts).all()).toEqual([]);
  });

  it("links attempts to the given run id", async () => {
    const { translationId } = await seedClaimedTranslation();
    const runId = randomUUID();
    await db.insert(schema.translationRuns).values({
      id: runId,
      provider: "claude-code",
      model: "claude-code:sonnet",
      promptVersion: "v1",
      workerId: WORKER,
      status: "running",
      startedAt: new Date().toISOString(),
    }).run();

    await persistTranslationBatch(
      basePersist({ runId, accepted: [acceptedItem(translationId)] }),
    );

    const attempts = await db.select().from(schema.translationAttempts).all();
    expect(attempts[0]?.runId).toBe(runId);
  });
});
