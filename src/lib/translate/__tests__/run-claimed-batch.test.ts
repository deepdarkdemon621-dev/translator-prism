import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as schema from "@/lib/db/schema";
import { CliOutputError } from "@/lib/llm/cli-output";
import type {
  ChapterBatchRequest,
  LLMProvider,
  TranslationBatchResult,
} from "@/lib/llm/types";
import type { ClaimedBatch } from "../../../worker/claim";
import { runClaimedTranslationBatch } from "@/lib/translate/run-claimed-batch";
import { sourceHash } from "@/lib/translate/source-hash";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const WORKER = "host:1:runner";

describe("runClaimedTranslationBatch", () => {
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

  async function seedClaimedBatch(
    sourceTexts: string[],
  ): Promise<{ batch: ClaimedBatch; chapterId: string }> {
    const bookId = randomUUID();
    const chapterId = randomUUID();
    await db.insert(schema.books).values({
      id: bookId,
      title: "書",
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
      title: "章",
      sourceHtml: "<p>x</p>",
      status: "translating",
    }).run();

    const items = [];
    const leaseExpiresAt = new Date(Date.now() + 600_000).toISOString();
    for (let seq = 0; seq < sourceTexts.length; seq++) {
      const paragraphId = randomUUID();
      const translationId = randomUUID();
      await db.insert(schema.paragraphs).values({
        id: paragraphId,
        chapterId,
        seq,
        sourceText: sourceTexts[seq],
        sourceMarkup: `<p>${sourceTexts[seq]}</p>`,
      }).run();
      await db.insert(schema.translations).values({
        id: translationId,
        paragraphId,
        lang: "zh",
        status: "processing",
        claimedBy: WORKER,
        leaseExpiresAt,
      }).run();
      items.push({
        translationId,
        paragraphId,
        lang: "zh",
        seq,
        sourceText: sourceTexts[seq],
        sourceHash: sourceHash(sourceTexts[seq]),
      });
    }

    return {
      chapterId,
      batch: {
        workerId: WORKER,
        leaseExpiresAt,
        bookId,
        bookTitle: "書",
        chapterId,
        chapterTitle: "章",
        sourceLang: "ja",
        lang: "zh",
        items,
      },
    };
  }

  function batchProvider(
    handler: (req: ChapterBatchRequest) => Promise<TranslationBatchResult[]>,
  ): LLMProvider {
    return {
      name: "claude-code",
      translate: async () => {
        throw new Error("single translate should not be called");
      },
      translateBatch: handler,
    };
  }

  const ok = (id: string, text: string): TranslationBatchResult => ({
    id,
    text,
    tokensUsed: 3,
    model: "claude-code:sonnet",
  });

  async function translationRow(id: string) {
    return db
      .select()
      .from(schema.translations)
      .where(eq(schema.translations.id, id))
      .get();
  }

  it("commits a fully accepted batch and refreshes the chapter", async () => {
    const { batch, chapterId } = await seedClaimedBatch([
      "彼は歩いた。",
      "彼女は笑った。",
    ]);
    const provider = batchProvider(async (req) =>
      req.items.map((item, i) => ok(item.id, `译文${i}`)),
    );

    const result = await runClaimedTranslationBatch({
      client,
      provider,
      batch,
      workerId: WORKER,
      runId: null,
      promptVersion: "v1",
    });

    expect(result).toMatchObject({ done: 2, failed: 0, released: 0, skipped: 0 });
    for (const [i, item] of batch.items.entries()) {
      const row = await translationRow(item.translationId);
      expect(row).toMatchObject({
        status: "done",
        text: `译文${i}`,
        claimedBy: null,
      });
    }
    const chapter = await db
      .select({ status: schema.chapters.status })
      .from(schema.chapters)
      .where(eq(schema.chapters.id, chapterId))
      .get();
    // zh rows are done but no en rows exist -> all existing translations done.
    expect(chapter?.status).toBe("done");
  });

  it("commits valid items while rejecting bad ones and releasing missing ones", async () => {
    const { batch } = await seedClaimedBatch([
      "彼は歩いた。",
      "彼女はゆっくりと笑った。",
      "夜が明けた。",
    ]);
    const [good, copy, missing] = batch.items;
    const provider = batchProvider(async () => [
      ok(good.translationId, "他走了。"),
      // Kana source copied straight through -> hard rejection.
      ok(copy.translationId, "彼女はゆっくりと笑った。"),
    ]);

    const result = await runClaimedTranslationBatch({
      client,
      provider,
      batch,
      workerId: WORKER,
      runId: null,
      promptVersion: "v1",
    });

    expect(result).toMatchObject({ done: 1, failed: 1, released: 1 });
    expect((await translationRow(good.translationId))?.status).toBe("done");

    const copyRow = await translationRow(copy.translationId);
    expect(copyRow?.status).toBe("failed");
    expect(copyRow?.lastErrorCode).toBe("invalid_output");

    const missingRow = await translationRow(missing.translationId);
    expect(missingRow).toMatchObject({
      status: "pending",
      claimedBy: null,
      leaseExpiresAt: null,
    });

    const attempts = await db.select().from(schema.translationAttempts).all();
    const rejectedAttempt = attempts.find(
      (a) => a.translationId === copy.translationId,
    );
    expect(rejectedAttempt).toMatchObject({ status: "rejected", isActive: 0 });
  });

  it("salvages a whole-batch parse failure through split retry", async () => {
    const { batch } = await seedClaimedBatch(["一つ。", "二つ。"]);
    let calls = 0;
    const provider = batchProvider(async (req) => {
      calls++;
      if (req.items.length > 1) throw new CliOutputError("garbage output");
      return [ok(req.items[0].id, `分割${req.items[0].seq}`)];
    });

    const result = await runClaimedTranslationBatch({
      client,
      provider,
      batch,
      workerId: WORKER,
      runId: null,
      promptVersion: "v1",
    });

    expect(calls).toBe(3);
    expect(result).toMatchObject({ done: 2, failed: 0 });
  });

  it("fails a single-item batch whose result never arrives", async () => {
    const { batch } = await seedClaimedBatch(["残された段落。"]);
    const provider = batchProvider(async () => [ok("unrelated-id", "??")]);

    const result = await runClaimedTranslationBatch({
      client,
      provider,
      batch,
      workerId: WORKER,
      runId: null,
      promptVersion: "v1",
    });

    expect(result).toMatchObject({ done: 0, failed: 1, released: 0 });
    const row = await translationRow(batch.items[0].translationId);
    expect(row?.status).toBe("failed");
    expect(row?.lastErrorCode).toBe("invalid_output");
  });

  it("marks the whole batch failed with a classified code on provider errors", async () => {
    const { batch } = await seedClaimedBatch(["一つ。", "二つ。"]);
    const provider = batchProvider(async () => {
      throw new Error("CLI process timed out after 120000ms");
    });

    const result = await runClaimedTranslationBatch({
      client,
      provider,
      batch,
      workerId: WORKER,
      runId: null,
      promptVersion: "v1",
    });

    expect(result).toMatchObject({ done: 0, failed: 2 });
    for (const item of batch.items) {
      const row = await translationRow(item.translationId);
      expect(row?.status).toBe("failed");
      expect(row?.lastErrorCode).toBe("network");
      expect(row?.claimedBy).toBeNull();
    }
  });
});
