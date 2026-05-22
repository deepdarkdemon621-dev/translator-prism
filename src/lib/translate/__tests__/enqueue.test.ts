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

describe("enqueueChapterTranslations", () => {
  let db: TestDb;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "translator-enqueue-"));
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

  async function seedImageOnlyChapter() {
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
      title: "Image",
      sourceHtml: '<svg><image xlink:href="../images/p.jpg"/></svg>',
      status: "pending",
    }).run();
    await db.insert(schema.paragraphs).values({
      id: randomUUID(),
      chapterId,
      seq: 0,
      sourceText: "",
      sourceMarkup: '<img src="/api/books/b/images/p.jpg" alt="">',
      kind: "image",
    }).run();
    return chapterId;
  }

  async function seedLegacyTextChapter() {
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
      title: "Legacy",
      sourceHtml: '<html><body><p>one</p><p>two</p></body></html>',
      status: "pending",
    }).run();
    return chapterId;
  }

  it("estimates no work for image-only chapters", async () => {
    const chapterId = await seedImageOnlyChapter();
    const { estimateChapterWork } = await import("@/lib/translate/enqueue");

    await expect(estimateChapterWork(chapterId, "ja")).resolves.toEqual({
      queuedChars: 0,
      queuedTranslations: 0,
    });
  });

  it("marks image-only chapters done instead of leaving them pending", async () => {
    const chapterId = await seedImageOnlyChapter();
    const { enqueueChapterTranslations } = await import("@/lib/translate/enqueue");

    await expect(enqueueChapterTranslations(chapterId, "ja")).resolves.toMatchObject({
      queued: 0,
      totalParagraphs: 0,
    });
    const row = await db
      .select({ status: schema.chapters.status })
      .from(schema.chapters)
      .where(eq(schema.chapters.id, chapterId))
      .get();
    expect(row?.status).toBe("done");
  });

  it("does not duplicate paragraphs when lazy extraction runs more than once", async () => {
    const chapterId = await seedLegacyTextChapter();
    const { lazyExtractParagraphs } = await import("@/lib/translate/enqueue");

    await lazyExtractParagraphs(chapterId);
    await lazyExtractParagraphs(chapterId);

    const rows = await db
      .select()
      .from(schema.paragraphs)
      .where(and(eq(schema.paragraphs.chapterId, chapterId), eq(schema.paragraphs.kind, "text")))
      .orderBy(schema.paragraphs.seq)
      .all();
    expect(rows.map((p) => p.sourceText)).toEqual(["one", "two"]);
  });
});
