import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { and, eq, inArray } from "drizzle-orm";
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

describe("enqueueChaptersBulk", () => {
  let db: TestDb;
  let bookId: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "translator-enqueue-book-"));
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

    const userId = randomUUID();
    bookId = randomUUID();
    await db.insert(schema.users).values({ id: userId, email: `${userId}@x`, isAdmin: 1 }).run();
    await db.insert(schema.books).values({
      id: bookId,
      title: "T",
      author: "A",
      sourceLang: "ja",
      filePath: "/t.epub",
      totalChapters: 4,
      status: "parsed",
      userId,
    }).run();
  });

  async function seedChapter(
    index: number,
    opts: {
      status?: string;
      sourceHtml?: string;
      paragraphs?: { text: string; kind?: "text" | "image" }[];
    } = {},
  ): Promise<{ chapterId: string; paragraphIds: string[] }> {
    const chapterId = randomUUID();
    await db.insert(schema.chapters).values({
      id: chapterId,
      bookId,
      index,
      title: `Ch${index}`,
      sourceHtml: opts.sourceHtml ?? "<p>x</p>",
      status: opts.status ?? "pending",
    }).run();
    const paragraphIds: string[] = [];
    for (const [seq, p] of (opts.paragraphs ?? []).entries()) {
      const paragraphId = randomUUID();
      paragraphIds.push(paragraphId);
      await db.insert(schema.paragraphs).values({
        id: paragraphId,
        chapterId,
        seq,
        sourceText: p.text,
        sourceMarkup: p.kind === "image" ? `<img src="/x.png" alt="${p.text}">` : `<p>${p.text}</p>`,
        kind: p.kind ?? "text",
      }).run();
    }
    return { chapterId, paragraphIds };
  }

  async function translationCount(paragraphIds: string[]): Promise<number> {
    if (paragraphIds.length === 0) return 0;
    const rows = await db
      .select({ id: schema.translations.id })
      .from(schema.translations)
      .where(inArray(schema.translations.paragraphId, paragraphIds))
      .all();
    return rows.length;
  }

  async function chapterStatus(chapterId: string): Promise<string | undefined> {
    const row = await db
      .select({ status: schema.chapters.status })
      .from(schema.chapters)
      .where(eq(schema.chapters.id, chapterId))
      .get();
    return row?.status;
  }

  it("enqueues several paragraph-bearing chapters in one call", async () => {
    const a = await seedChapter(0, { paragraphs: [{ text: "甲" }, { text: "乙" }] });
    const b = await seedChapter(1, { paragraphs: [{ text: "丙" }] });

    const { enqueueChaptersBulk } = await import("@/lib/translate/enqueue");
    const res = await enqueueChaptersBulk([a.chapterId, b.chapterId], "ja");

    expect(res.queued).toBe(6); // 3 paragraphs x zh/en
    expect(res.chaptersQueued).toBe(2);
    expect(res.remainingChapterIds).toEqual([]);
    expect(await translationCount(a.paragraphIds)).toBe(4);
    expect(await translationCount(b.paragraphIds)).toBe(2);
    expect(await chapterStatus(a.chapterId)).toBe("translating");
    expect(await chapterStatus(b.chapterId)).toBe("translating");
  });

  it("marks image-only chapters done without creating translations", async () => {
    const img = await seedChapter(0, {
      paragraphs: [
        { text: "", kind: "image" },
        { text: "口絵", kind: "image" },
      ],
    });

    const { enqueueChaptersBulk } = await import("@/lib/translate/enqueue");
    const res = await enqueueChaptersBulk([img.chapterId], "ja");

    expect(res.queued).toBe(0);
    expect(res.imageOnlyMarkedDone).toBe(1);
    expect(await translationCount(img.paragraphIds)).toBe(0);
    expect(await chapterStatus(img.chapterId)).toBe("done");
  });

  it("skips done keys and never duplicates on re-run", async () => {
    const a = await seedChapter(0, { paragraphs: [{ text: "甲" }] });
    await db.insert(schema.translations).values({
      id: randomUUID(),
      paragraphId: a.paragraphIds[0],
      lang: "zh",
      status: "done",
      text: "完成",
    }).run();

    const { enqueueChaptersBulk } = await import("@/lib/translate/enqueue");
    const first = await enqueueChaptersBulk([a.chapterId], "ja");
    expect(first.queued).toBe(1); // only en
    expect(first.skippedDone).toBe(1);

    const second = await enqueueChaptersBulk([a.chapterId], "ja");
    expect(second.queued).toBe(1); // en row reset back to pending, no new rows

    expect(await translationCount(a.paragraphIds)).toBe(2);
    const done = await db
      .select()
      .from(schema.translations)
      .where(
        and(
          eq(schema.translations.paragraphId, a.paragraphIds[0]),
          eq(schema.translations.lang, "zh"),
        ),
      )
      .get();
    expect(done?.status).toBe("done");
    expect(done?.text).toBe("完成");
  });

  // cheerio's dynamic import is slow under vitest's on-the-fly transform.
  it("extracts legacy zero-paragraph chapters and enqueues them", { timeout: 60000 }, async () => {
    const legacy = await seedChapter(0, {
      sourceHtml: "<html><body><p>一つ目の段落。</p><p>二つ目の段落。</p></body></html>",
    });

    const { enqueueChaptersBulk } = await import("@/lib/translate/enqueue");
    const res = await enqueueChaptersBulk([legacy.chapterId], "ja");

    expect(res.extractedChapters).toBe(1);
    expect(res.queued).toBe(4); // 2 paragraphs x zh/en
    expect(res.remainingChapterIds).toEqual([]);
    const paras = await db
      .select({ id: schema.paragraphs.id })
      .from(schema.paragraphs)
      .where(eq(schema.paragraphs.chapterId, legacy.chapterId))
      .all();
    expect(paras.length).toBe(2);
    expect(await translationCount(paras.map((p) => p.id))).toBe(4);
    expect(await chapterStatus(legacy.chapterId)).toBe("translating");
  });

  it("inlines gaiji image alt text during legacy extraction", { timeout: 60000 }, async () => {
    const legacy = await seedChapter(0, {
      sourceHtml:
        `<html><body><p>『<img src="images/gaiji.png" alt="櫛"/>田』の名だ。</p></body></html>`,
    });

    const { enqueueChaptersBulk } = await import("@/lib/translate/enqueue");
    await enqueueChaptersBulk([legacy.chapterId], "ja");

    const paras = await db
      .select({ sourceText: schema.paragraphs.sourceText, kind: schema.paragraphs.kind })
      .from(schema.paragraphs)
      .where(eq(schema.paragraphs.chapterId, legacy.chapterId))
      .all();
    expect(paras).toHaveLength(1);
    expect(paras[0].kind).toBe("text");
    expect(paras[0].sourceText).toBe("『櫛田』の名だ。");
  });

  it("defers legacy extraction chapters when the time budget is exhausted", async () => {
    const a = await seedChapter(0, { paragraphs: [{ text: "甲" }] });
    const legacy = await seedChapter(1, {
      sourceHtml: "<html><body><p>後回しの章。</p></body></html>",
    });

    const { enqueueChaptersBulk } = await import("@/lib/translate/enqueue");
    const res = await enqueueChaptersBulk([a.chapterId, legacy.chapterId], "ja", {
      timeBudgetMs: 0,
    });

    // Cheap bulk path still ran; only the expensive extraction was deferred.
    expect(res.queued).toBe(2);
    expect(res.remainingChapterIds).toEqual([legacy.chapterId]);
    expect(res.extractedChapters).toBe(0);
    const paras = await db
      .select({ id: schema.paragraphs.id })
      .from(schema.paragraphs)
      .where(eq(schema.paragraphs.chapterId, legacy.chapterId))
      .all();
    expect(paras.length).toBe(0);
  });
});
