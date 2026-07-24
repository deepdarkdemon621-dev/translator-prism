import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as schema from "../../src/lib/db/schema";
import { sourceHash } from "../../src/lib/translate/source-hash";
import {
  claimTranslationBatch,
  makeWorkerId,
  releaseClaims,
  renewLeases,
} from "../claim";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

describe("lease-based chapter/language claiming", () => {
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
    await db.delete(schema.translations).run();
    await db.delete(schema.paragraphs).run();
    await db.delete(schema.chapters).run();
    await db.delete(schema.books).run();
  });

  interface SeededChapter {
    bookId: string;
    chapterId: string;
    paragraphIds: string[];
  }

  async function seedChapter(params: {
    bookTitle?: string;
    chapterTitle?: string;
    paragraphTexts: string[];
  }): Promise<SeededChapter> {
    const bookId = randomUUID();
    const chapterId = randomUUID();
    await db.insert(schema.books).values({
      id: bookId,
      title: params.bookTitle ?? "書名",
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
      title: params.chapterTitle ?? "第一章",
      sourceHtml: "<p>x</p>",
      status: "pending",
    }).run();
    const paragraphIds: string[] = [];
    for (let seq = 0; seq < params.paragraphTexts.length; seq++) {
      const paragraphId = randomUUID();
      paragraphIds.push(paragraphId);
      await db.insert(schema.paragraphs).values({
        id: paragraphId,
        chapterId,
        seq,
        sourceText: params.paragraphTexts[seq],
        sourceMarkup: `<p>${params.paragraphTexts[seq]}</p>`,
      }).run();
    }
    return { bookId, chapterId, paragraphIds };
  }

  async function insertTranslation(
    paragraphId: string,
    values: Partial<typeof schema.translations.$inferInsert> = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.translations).values({
      id,
      paragraphId,
      lang: "zh",
      status: "pending",
      ...values,
    }).run();
    return id;
  }

  const baseOptions = (overrides: Record<string, unknown> = {}) => ({
    client,
    workerId: "host:123:abc",
    batchSize: 10,
    leaseMs: 600_000,
    ...overrides,
  });

  it("returns null when nothing is eligible", async () => {
    const { paragraphIds } = await seedChapter({ paragraphTexts: ["a"] });
    await insertTranslation(paragraphIds[0], { status: "done", text: "done" });
    await insertTranslation(paragraphIds[0], { lang: "en", status: "cancelled" });
    expect(await claimTranslationBatch(baseOptions())).toBeNull();
  });

  it("claims only pending rows and writes worker id, lease, and status atomically", async () => {
    const now = new Date("2026-07-24T10:00:00.000Z");
    const { chapterId, paragraphIds } = await seedChapter({
      paragraphTexts: ["一", "二", "三"],
    });
    const pending1 = await insertTranslation(paragraphIds[0]);
    const pending2 = await insertTranslation(paragraphIds[1]);
    await insertTranslation(paragraphIds[2], { status: "failed" });

    const batch = await claimTranslationBatch(baseOptions({ now }));
    expect(batch).not.toBeNull();
    expect(batch!.chapterId).toBe(chapterId);
    expect(batch!.lang).toBe("zh");
    expect(batch!.items.map((i) => i.translationId)).toEqual([pending1, pending2]);

    for (const id of [pending1, pending2]) {
      const row = await db
        .select()
        .from(schema.translations)
        .where(eq(schema.translations.id, id))
        .get();
      expect(row?.status).toBe("processing");
      expect(row?.claimedBy).toBe("host:123:abc");
      expect(row?.leaseExpiresAt).toBe(
        new Date(now.getTime() + 600_000).toISOString(),
      );
    }
  });

  it("keeps one chapter and one target language per batch", async () => {
    const first = await seedChapter({ paragraphTexts: ["一", "二"] });
    const second = await seedChapter({ paragraphTexts: ["三"] });
    // Oldest seed row: chapter 1 zh. Chapter 1 also has en rows and chapter 2
    // has zh rows; neither may enter this batch.
    await insertTranslation(first.paragraphIds[0], {
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await insertTranslation(first.paragraphIds[1], {
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    await insertTranslation(first.paragraphIds[0], {
      lang: "en",
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    await insertTranslation(second.paragraphIds[0], {
      createdAt: "2026-01-04T00:00:00.000Z",
    });

    const batch = await claimTranslationBatch(baseOptions());
    expect(batch!.chapterId).toBe(first.chapterId);
    expect(batch!.lang).toBe("zh");
    expect(batch!.items).toHaveLength(2);
    expect(batch!.items.every((i) => i.lang === "zh")).toBe(true);
  });

  it("orders items by paragraph sequence and returns request metadata", async () => {
    const { chapterId, paragraphIds } = await seedChapter({
      bookTitle: "テスト書",
      chapterTitle: "序章",
      paragraphTexts: ["先", "後"],
    });
    // Insert out of order: the later paragraph's row is older.
    await insertTranslation(paragraphIds[1], {
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await insertTranslation(paragraphIds[0], {
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    const batch = await claimTranslationBatch(baseOptions());
    expect(batch!.bookTitle).toBe("テスト書");
    expect(batch!.chapterTitle).toBe("序章");
    expect(batch!.sourceLang).toBe("ja");
    expect(batch!.chapterId).toBe(chapterId);
    expect(batch!.items.map((i) => i.seq)).toEqual([0, 1]);
    expect(batch!.items.map((i) => i.sourceText)).toEqual(["先", "後"]);
    expect(batch!.items[0].sourceHash).toBe(sourceHash("先"));
  });

  it("reclaims expired or legacy processing rows but never an unexpired lease", async () => {
    const now = new Date("2026-07-24T10:00:00.000Z");
    const { paragraphIds } = await seedChapter({
      paragraphTexts: ["一", "二", "三"],
    });
    const expired = await insertTranslation(paragraphIds[0], {
      status: "processing",
      claimedBy: "other:1:x",
      leaseExpiresAt: "2026-07-24T09:00:00.000Z",
    });
    const legacy = await insertTranslation(paragraphIds[1], {
      status: "processing",
      claimedBy: null,
      leaseExpiresAt: null,
    });
    const held = await insertTranslation(paragraphIds[2], {
      status: "processing",
      claimedBy: "other:1:x",
      leaseExpiresAt: "2026-07-24T11:00:00.000Z",
    });

    const batch = await claimTranslationBatch(baseOptions({ now }));
    const ids = batch!.items.map((i) => i.translationId);
    expect(ids).toContain(expired);
    expect(ids).toContain(legacy);
    expect(ids).not.toContain(held);

    const heldRow = await db
      .select()
      .from(schema.translations)
      .where(eq(schema.translations.id, held))
      .get();
    expect(heldRow?.claimedBy).toBe("other:1:x");
  });

  it("applies the batch size and character budget but always claims at least one", async () => {
    const { paragraphIds } = await seedChapter({
      paragraphTexts: ["あ".repeat(100), "い".repeat(100), "う".repeat(100)],
    });
    for (const paragraphId of paragraphIds) await insertTranslation(paragraphId);

    const budgeted = await claimTranslationBatch(
      baseOptions({ batchSize: 10, maxChars: 150 }),
    );
    expect(budgeted!.items).toHaveLength(1);

    // Remaining rows: the next claim is also budget-limited but not empty.
    const next = await claimTranslationBatch(
      baseOptions({ batchSize: 1, maxChars: 10_000 }),
    );
    expect(next!.items).toHaveLength(1);
  });

  it("claims only one row per (paragraph_id, lang) when duplicates exist", async () => {
    const { paragraphIds } = await seedChapter({ paragraphTexts: ["一"] });
    const older = await insertTranslation(paragraphIds[0], {
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const duplicate = await insertTranslation(paragraphIds[0], {
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    const batch = await claimTranslationBatch(baseOptions());
    expect(batch!.items.map((i) => i.translationId)).toEqual([older]);

    const dupRow = await db
      .select()
      .from(schema.translations)
      .where(eq(schema.translations.id, duplicate))
      .get();
    expect(dupRow?.status).toBe("pending");
  });

  it("renews leases only for rows owned by the requesting worker", async () => {
    const now = new Date("2026-07-24T10:00:00.000Z");
    const { paragraphIds } = await seedChapter({ paragraphTexts: ["一", "二"] });
    const mine = await insertTranslation(paragraphIds[0], {
      status: "processing",
      claimedBy: "me:1:a",
      leaseExpiresAt: "2026-07-24T10:05:00.000Z",
    });
    const theirs = await insertTranslation(paragraphIds[1], {
      status: "processing",
      claimedBy: "other:2:b",
      leaseExpiresAt: "2026-07-24T10:05:00.000Z",
    });

    const renewed = await renewLeases({
      client,
      workerId: "me:1:a",
      translationIds: [mine, theirs],
      leaseMs: 600_000,
      now,
    });
    expect(renewed).toBe(1);

    const mineRow = await db
      .select()
      .from(schema.translations)
      .where(eq(schema.translations.id, mine))
      .get();
    expect(mineRow?.leaseExpiresAt).toBe(
      new Date(now.getTime() + 600_000).toISOString(),
    );
    const theirsRow = await db
      .select()
      .from(schema.translations)
      .where(eq(schema.translations.id, theirs))
      .get();
    expect(theirsRow?.leaseExpiresAt).toBe("2026-07-24T10:05:00.000Z");
  });

  it("releases only rows owned by the requesting worker back to pending", async () => {
    const { paragraphIds } = await seedChapter({ paragraphTexts: ["一", "二"] });
    const mine = await insertTranslation(paragraphIds[0], {
      status: "processing",
      claimedBy: "me:1:a",
      leaseExpiresAt: "2026-07-24T10:05:00.000Z",
    });
    const theirs = await insertTranslation(paragraphIds[1], {
      status: "processing",
      claimedBy: "other:2:b",
      leaseExpiresAt: "2026-07-24T10:05:00.000Z",
    });

    const released = await releaseClaims({
      client,
      workerId: "me:1:a",
      translationIds: [mine, theirs],
    });
    expect(released).toBe(1);

    const mineRow = await db
      .select()
      .from(schema.translations)
      .where(eq(schema.translations.id, mine))
      .get();
    expect(mineRow).toMatchObject({
      status: "pending",
      claimedBy: null,
      leaseExpiresAt: null,
    });
    const theirsRow = await db
      .select()
      .from(schema.translations)
      .where(eq(schema.translations.id, theirs))
      .get();
    expect(theirsRow?.status).toBe("processing");
  });
});

describe("makeWorkerId", () => {
  it("builds hostname:pid:uuid identifiers", () => {
    const id = makeWorkerId();
    const parts = id.split(":");
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(Number(parts[parts.length - 2])).toBe(process.pid);
    expect(parts[parts.length - 1]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
