import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as schema from "@/lib/db/schema";
import { dedupeImportTranslationRows } from "@/lib/translate/import-dedupe";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let _testDb: TestDb | null = null;
let client: Client;
let tempDir: string;

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!_testDb) throw new Error("test DB not initialised");
    return _testDb;
  },
}));

describe("uniqueness-safe translation inserts", () => {
  let db: TestDb;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "translator-enqueue-unique-"));
    client = createClient({ url: `file:${join(tempDir, "test.sqlite")}` });
    await migrate(drizzle(client, { schema }), { migrationsFolder: "./drizzle" });
    db = drizzle(client, { schema });
    _testDb = db;
  });

  afterAll(async () => {
    _testDb = null;
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // libsql can release Windows file handles after the process exits.
    }
  });

  beforeEach(async () => {
    await db.delete(schema.translations).run();
    await db.delete(schema.paragraphs).run();
    await db.delete(schema.chapters).run();
    await db.delete(schema.books).run();
    await db.delete(schema.users).run();
  });

  async function seedChapter(paragraphCount = 2): Promise<{
    chapterId: string;
    paragraphIds: string[];
  }> {
    const userId = randomUUID();
    const bookId = randomUUID();
    const chapterId = randomUUID();
    await db.insert(schema.users).values({ id: userId, email: `${userId}@x`, isAdmin: 1 }).run();
    await db.insert(schema.books).values({
      id: bookId,
      title: "T",
      author: "A",
      sourceLang: "ja",
      filePath: "/t.epub",
      totalChapters: 1,
      status: "parsed",
      userId,
    }).run();
    await db.insert(schema.chapters).values({
      id: chapterId,
      bookId,
      index: 0,
      title: "Ch",
      sourceHtml: "<p>x</p>",
      status: "pending",
    }).run();
    const paragraphIds: string[] = [];
    for (let seq = 0; seq < paragraphCount; seq++) {
      const paragraphId = randomUUID();
      paragraphIds.push(paragraphId);
      await db.insert(schema.paragraphs).values({
        id: paragraphId,
        chapterId,
        seq,
        sourceText: `原文${seq}`,
        sourceMarkup: `<p>原文${seq}</p>`,
      }).run();
    }
    return { chapterId, paragraphIds };
  }

  async function countByKey(paragraphId: string, lang: string): Promise<number> {
    const rows = await db
      .select({ id: schema.translations.id })
      .from(schema.translations)
      .where(
        and(
          eq(schema.translations.paragraphId, paragraphId),
          eq(schema.translations.lang, lang),
        ),
      )
      .all();
    return rows.length;
  }

  it("skips candidates whose key was inserted after the existence read", async () => {
    const { paragraphIds } = await seedChapter(1);
    // Simulate the enqueue race deterministically: another enqueue inserted
    // this (paragraph_id, lang) after our caller read the existing rows.
    await db.insert(schema.translations).values({
      id: randomUUID(),
      paragraphId: paragraphIds[0],
      lang: "zh",
      status: "pending",
    }).run();

    const { insertPendingTranslationsIfAbsent } = await import("@/lib/translate/enqueue");
    await insertPendingTranslationsIfAbsent(
      db,
      [
        { id: randomUUID(), paragraphId: paragraphIds[0], lang: "zh" },
        { id: randomUUID(), paragraphId: paragraphIds[0], lang: "en" },
      ],
      new Date().toISOString(),
    );

    expect(await countByKey(paragraphIds[0], "zh")).toBe(1);
    expect(await countByKey(paragraphIds[0], "en")).toBe(1);
  });

  it("keeps one canonical row per (paragraph_id, lang) across repeated enqueues", async () => {
    const { chapterId, paragraphIds } = await seedChapter(3);
    const { enqueueChapterTranslations } = await import("@/lib/translate/enqueue");

    await enqueueChapterTranslations(chapterId, "ja");
    await enqueueChapterTranslations(chapterId, "ja");

    for (const paragraphId of paragraphIds) {
      for (const lang of ["zh", "en"]) {
        expect(await countByKey(paragraphId, lang)).toBe(1);
      }
    }
  });

  it("never resets or duplicates a key that already has a done row", async () => {
    const { chapterId, paragraphIds } = await seedChapter(1);
    const doneId = randomUUID();
    await db.insert(schema.translations).values({
      id: doneId,
      paragraphId: paragraphIds[0],
      lang: "zh",
      status: "done",
      text: "完成译文",
    }).run();
    // Pre-existing duplicate of the same key, still pending (production has
    // 9330 of these). Enqueue must not reset it while a done row exists.
    const duplicateId = randomUUID();
    await db.insert(schema.translations).values({
      id: duplicateId,
      paragraphId: paragraphIds[0],
      lang: "zh",
      status: "pending",
    }).run();

    const { enqueueChapterTranslations } = await import("@/lib/translate/enqueue");
    const result = await enqueueChapterTranslations(chapterId, "ja");
    expect(result.skippedDone).toBe(1);

    const done = await db
      .select()
      .from(schema.translations)
      .where(eq(schema.translations.id, doneId))
      .get();
    expect(done?.status).toBe("done");
    expect(done?.text).toBe("完成译文");
    expect(await countByKey(paragraphIds[0], "zh")).toBe(2); // unchanged, cleanup is dedupe's job
    expect(await countByKey(paragraphIds[0], "en")).toBe(1); // en side still enqueued
  });

  it("stays compatible with the future 0014 unique index", async () => {
    const { chapterId, paragraphIds } = await seedChapter(2);
    const { enqueueChapterTranslations } = await import("@/lib/translate/enqueue");
    await enqueueChapterTranslations(chapterId, "ja");

    // On a clean database the gated 0014 index must be creatable, and a
    // repeat enqueue must not violate it.
    await client.execute(
      "CREATE UNIQUE INDEX `idx_translations_paragraph_lang` ON `translations` (`paragraph_id`, `lang`)",
    );
    await enqueueChapterTranslations(chapterId, "ja");
    for (const paragraphId of paragraphIds) {
      expect(await countByKey(paragraphId, "zh")).toBe(1);
      expect(await countByKey(paragraphId, "en")).toBe(1);
    }
    await client.execute("DROP INDEX `idx_translations_paragraph_lang`");
  });
});

describe("dedupeImportTranslationRows", () => {
  const base = {
    id: "x",
    paragraphId: "p1",
    lang: "zh",
    text: "",
    status: "pending",
    model: null as string | null,
    tokensUsed: null as number | null,
  };

  it("keeps one row per key preferring completed non-empty text", () => {
    const rows = [
      { ...base, id: "a", status: "pending" },
      { ...base, id: "b", status: "done", text: "译文" },
      { ...base, id: "c", status: "done", text: "另一份" },
      { ...base, id: "d", paragraphId: "p2", status: "pending" },
    ];
    const { rows: deduped, dropped } = dedupeImportTranslationRows(rows);
    expect(deduped.map((r) => r.id)).toEqual(["b", "d"]);
    expect(dropped).toBe(2);
  });

  it("falls back to the first row when no candidate is done", () => {
    const rows = [
      { ...base, id: "a" },
      { ...base, id: "b" },
    ];
    const { rows: deduped, dropped } = dedupeImportTranslationRows(rows);
    expect(deduped.map((r) => r.id)).toEqual(["a"]);
    expect(dropped).toBe(1);
  });
});
