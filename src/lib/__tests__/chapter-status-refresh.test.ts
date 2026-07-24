import { createClient, type Client, type InStatement } from "@libsql/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as schema from "@/lib/db/schema";
import { refreshChaptersStatus } from "@/lib/chapter-status";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

describe("refreshChaptersStatus", () => {
  let client: Client;
  let db: TestDb;
  let executeCount: number;
  let batchCount: number;
  let spyClient: Client;

  beforeAll(async () => {
    client = createClient({ url: "file::memory:" });
    await migrate(drizzle(client, { schema }), { migrationsFolder: "./drizzle" });
    db = drizzle(client, { schema });
    spyClient = new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          return (stmt: InStatement) => {
            executeCount++;
            return target.execute(stmt as never);
          };
        }
        if (prop === "batch") {
          return (...args: Parameters<Client["batch"]>) => {
            batchCount++;
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
    executeCount = 0;
    batchCount = 0;
    await db.delete(schema.translations).run();
    await db.delete(schema.paragraphs).run();
    await db.delete(schema.chapters).run();
    await db.delete(schema.books).run();
  });

  async function seedChapter(status = "translating"): Promise<{
    chapterId: string;
    paragraphId: string;
  }> {
    const bookId = randomUUID();
    const chapterId = randomUUID();
    const paragraphId = randomUUID();
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
      status,
    }).run();
    await db.insert(schema.paragraphs).values({
      id: paragraphId,
      chapterId,
      seq: 0,
      sourceText: "原文",
      sourceMarkup: "<p>原文</p>",
    }).run();
    return { chapterId, paragraphId };
  }

  async function chapterStatus(chapterId: string): Promise<string | undefined> {
    const row = await db
      .select({ status: schema.chapters.status })
      .from(schema.chapters)
      .where(eq(schema.chapters.id, chapterId))
      .get();
    return row?.status;
  }

  it("updates several chapters with one grouped aggregate and one batch", async () => {
    const done = await seedChapter();
    await db.insert(schema.translations).values({
      id: randomUUID(),
      paragraphId: done.paragraphId,
      lang: "zh",
      status: "done",
      text: "完成",
    }).run();

    const errored = await seedChapter();
    await db.insert(schema.translations).values({
      id: randomUUID(),
      paragraphId: errored.paragraphId,
      lang: "zh",
      status: "failed",
    }).run();

    const inFlight = await seedChapter();
    await db.insert(schema.translations).values({
      id: randomUUID(),
      paragraphId: inFlight.paragraphId,
      lang: "zh",
      status: "pending",
    }).run();

    await refreshChaptersStatus(spyClient, [
      done.chapterId,
      errored.chapterId,
      inFlight.chapterId,
      done.chapterId, // duplicates collapse
    ]);

    expect(await chapterStatus(done.chapterId)).toBe("done");
    expect(await chapterStatus(errored.chapterId)).toBe("error");
    expect(await chapterStatus(inFlight.chapterId)).toBe("translating");

    // One grouped aggregate; no per-chapter kind query was needed; one write batch.
    expect(executeCount).toBe(1);
    expect(batchCount).toBe(1);
  });

  it("marks image-only chapters with no translations as done", async () => {
    const bookId = randomUUID();
    const chapterId = randomUUID();
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
      title: "Image",
      sourceHtml: "<img>",
      status: "translating",
    }).run();
    await db.insert(schema.paragraphs).values({
      id: randomUUID(),
      chapterId,
      seq: 0,
      sourceText: "",
      sourceMarkup: '<img src="/x.jpg">',
      kind: "image",
    }).run();

    await refreshChaptersStatus(spyClient, [chapterId]);
    expect(await chapterStatus(chapterId)).toBe("done");
  });

  it("does nothing for an empty chapter list", async () => {
    await refreshChaptersStatus(spyClient, []);
    expect(executeCount).toBe(0);
    expect(batchCount).toBe(0);
  });
});
