import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as schema from "@/lib/db/schema";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let _testDb: TestDb | null = null;
let client: Client;
const statements: string[] = [];

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!_testDb) throw new Error("test DB not initialised");
    return _testDb;
  },
}));

function instrumentClient(base: Client): Client {
  return {
    execute(statement) {
      statements.push(
        typeof statement === "string" ? statement : statement.sql,
      );
      return base.execute(statement);
    },
    batch(batchStatements, mode) {
      for (const statement of batchStatements) {
        statements.push(
          typeof statement === "string" ? statement : statement.sql,
        );
      }
      return base.batch(batchStatements, mode);
    },
    close: () => base.close(),
    closed: base.closed,
    protocol: base.protocol,
    sync: () => base.sync(),
    transaction: (mode) => base.transaction(mode),
    executeMultiple: (sql) => base.executeMultiple(sql),
    migrate: (stmts) => base.migrate(stmts),
  } as Client;
}

describe("checkChapterDone", () => {
  let db: TestDb;

  beforeAll(async () => {
    client = createClient({ url: "file::memory:" });
    await migrate(drizzle(client, { schema }), { migrationsFolder: "./drizzle" });
    db = drizzle(instrumentClient(client), { schema });
    _testDb = db;
  });

  afterAll(() => {
    _testDb = null;
    client.close();
  });

  beforeEach(async () => {
    statements.length = 0;
    await db.delete(schema.translations).run();
    await db.delete(schema.paragraphs).run();
    await db.delete(schema.chapters).run();
    await db.delete(schema.books).run();
    await db.delete(schema.users).run();
    statements.length = 0;
  });

  async function seedChapter(statuses: Array<"done" | "failed" | "pending" | "processing">) {
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
      title: "C",
      sourceHtml: "<p>x</p>",
      status: "translating",
    }).run();
    for (let i = 0; i < statuses.length; i++) {
      const paragraphId = randomUUID();
      await db.insert(schema.paragraphs).values({
        id: paragraphId,
        chapterId,
        seq: i,
        sourceText: "x",
        sourceMarkup: "<p>x</p>",
        kind: "text",
      }).run();
      await db.insert(schema.translations).values({
        id: randomUUID(),
        paragraphId,
        lang: "zh",
        status: statuses[i],
        text: statuses[i] === "done" ? "y" : "",
      }).run();
    }
    statements.length = 0;
    return chapterId;
  }

  async function statusAfter(chapterId: string) {
    const { checkChapterDone } = await import("@/lib/chapter-status");
    await checkChapterDone(chapterId);
    return db
      .select()
      .from(schema.chapters)
      .where(eq(schema.chapters.id, chapterId))
      .get()
      .then((row) => row?.status);
  }

  it("marks chapter done when every known translation is done", async () => {
    const chapterId = await seedChapter(["done", "done"]);
    expect(await statusAfter(chapterId)).toBe("done");
  });

  it("marks chapter error when failures remain and no work is active", async () => {
    const chapterId = await seedChapter(["done", "failed"]);
    expect(await statusAfter(chapterId)).toBe("error");
  });

  it("leaves chapter translating while pending work exists", async () => {
    const chapterId = await seedChapter(["done", "failed", "pending"]);
    expect(await statusAfter(chapterId)).toBe("translating");
  });

  it("leaves chapter translating while processing work exists", async () => {
    const chapterId = await seedChapter(["done", "failed", "processing"]);
    expect(await statusAfter(chapterId)).toBe("translating");
  });

  it("does not mark empty translation chapters done", async () => {
    const chapterId = await seedChapter([]);
    expect(await statusAfter(chapterId)).toBe("translating");
  });

  it("checks chapter completion with one aggregate status read", async () => {
    const chapterId = await seedChapter(["done", "done", "done", "done"]);
    await statusAfter(chapterId);

    const statusReads = statements.filter(
      (statement) =>
        statement.toLowerCase().startsWith("select") &&
        statement.includes("translations"),
    );
    expect(statusReads).toHaveLength(1);
  });
});
