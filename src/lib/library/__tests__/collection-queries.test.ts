import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { randomUUID } from "crypto";
import * as schema from "@/lib/db/schema";
import {
  listVisibleCollectionsWithSummaries,
  loadCollectionBooksWithProgress,
} from "@/lib/library/collection-queries";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const statements: string[] = [];

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

describe("collection query helpers", () => {
  let client: Client;
  let db: TestDb;

  beforeAll(async () => {
    client = createClient({ url: "file::memory:" });
    await migrate(drizzle(client, { schema }), { migrationsFolder: "./drizzle" });
    db = drizzle(instrumentClient(client), { schema });
  });

  afterAll(() => {
    client.close();
  });

  beforeEach(async () => {
    statements.length = 0;
    await db.delete(schema.translations).run();
    await db.delete(schema.paragraphs).run();
    await db.delete(schema.chapters).run();
    await db.delete(schema.books).run();
    await db.delete(schema.collections).run();
    await db.delete(schema.users).run();
    statements.length = 0;
  });

  async function makeUser(isAdmin = false): Promise<string> {
    const id = randomUUID();
    await db
      .insert(schema.users)
      .values({ id, email: `${id}@example.test`, isAdmin: isAdmin ? 1 : 0 })
      .run();
    return id;
  }

  async function makeCollection(params: {
    id: string;
    userId: string;
    visibility?: "public" | "private";
  }) {
    await db
      .insert(schema.collections)
      .values({
        id: params.id,
        userId: params.userId,
        name: params.id,
        visibility: params.visibility ?? "private",
      })
      .run();
  }

  async function makeBook(params: {
    id: string;
    userId: string;
    collectionId: string;
    visibility?: "public" | "private";
    seq?: number;
    coverPath?: string | null;
    totalChapters?: number;
  }) {
    await db
      .insert(schema.books)
      .values({
        id: params.id,
        title: params.id,
        author: "A",
        sourceLang: "ja",
        filePath: `/${params.id}.epub`,
        totalChapters: params.totalChapters ?? 0,
        status: "parsed",
        userId: params.userId,
        visibility: params.visibility ?? "private",
        collectionId: params.collectionId,
        collectionSeq: params.seq ?? 0,
        coverPath: params.coverPath ?? null,
      })
      .run();
  }

  async function makeChapter(params: {
    id: string;
    bookId: string;
    status?: "pending" | "translating" | "done" | "error";
  }) {
    await db
      .insert(schema.chapters)
      .values({
        id: params.id,
        bookId: params.bookId,
        index: 0,
        title: params.id,
        sourceHtml: "<p>x</p>",
        status: params.status ?? "pending",
      })
      .run();
  }

  async function makeTranslation(params: {
    id: string;
    chapterId: string;
    status: "pending" | "processing" | "done" | "failed";
  }) {
    const paragraphId = `${params.id}-paragraph`;
    await db
      .insert(schema.paragraphs)
      .values({
        id: paragraphId,
        chapterId: params.chapterId,
        seq: 0,
        sourceText: "x",
        sourceMarkup: "<p>x</p>",
        kind: "text",
      })
      .run();
    await db
      .insert(schema.translations)
      .values({
        id: params.id,
        paragraphId,
        lang: "zh",
        text: params.status === "done" ? "y" : "",
        status: params.status,
      })
      .run();
  }

  function selectStatements(): string[] {
    return statements.filter((statement) =>
      statement.trim().toLowerCase().startsWith("select"),
    );
  }

  it("lists visible collections with summaries without per-collection queries", async () => {
    const admin = await makeUser(true);
    const user = await makeUser();
    await makeCollection({ id: "own", userId: user, visibility: "private" });
    await makeCollection({ id: "admin-public", userId: admin, visibility: "public" });
    await makeBook({
      id: "own-private",
      userId: user,
      collectionId: "own",
      visibility: "private",
      seq: 0,
      coverPath: "/own.jpg",
    });
    await makeBook({
      id: "admin-private-first",
      userId: admin,
      collectionId: "admin-public",
      visibility: "private",
      seq: 0,
      coverPath: "/private.jpg",
    });
    await makeBook({
      id: "admin-public-second",
      userId: admin,
      collectionId: "admin-public",
      visibility: "public",
      seq: 1,
      coverPath: "/public.jpg",
    });
    statements.length = 0;

    const rows = await listVisibleCollectionsWithSummaries(db, {
      id: user,
      isAdmin: false,
    });

    expect(rows.map((row) => row.id).sort()).toEqual(["admin-public", "own"]);
    expect(rows.find((row) => row.id === "own")).toMatchObject({
      bookCount: 1,
      coverBookId: "own-private",
      coverPath: "/own.jpg",
    });
    expect(rows.find((row) => row.id === "admin-public")).toMatchObject({
      bookCount: 1,
      coverBookId: "admin-public-second",
      coverPath: "/public.jpg",
    });
    expect(selectStatements()).toHaveLength(6);
  });

  it("loads collection book progress without per-book queries", async () => {
    const owner = await makeUser();
    await makeCollection({ id: "series", userId: owner });
    await makeBook({
      id: "book-a",
      userId: owner,
      collectionId: "series",
      visibility: "private",
      seq: 0,
      totalChapters: 2,
    });
    await makeBook({
      id: "book-b",
      userId: owner,
      collectionId: "series",
      visibility: "private",
      seq: 1,
      totalChapters: 1,
    });
    await makeChapter({ id: "a-done", bookId: "book-a", status: "done" });
    await makeChapter({ id: "a-pending", bookId: "book-a" });
    await makeChapter({ id: "b-done", bookId: "book-b", status: "done" });
    await makeTranslation({ id: "a-queued", chapterId: "a-pending", status: "pending" });
    await makeTranslation({ id: "b-done-translation", chapterId: "b-done", status: "done" });
    statements.length = 0;

    const rows = await loadCollectionBooksWithProgress(db, "series", {
      includePrivateMembers: true,
    });

    expect(rows).toMatchObject([
      { id: "book-a", translatedChapters: 1, pendingTranslations: 1 },
      { id: "book-b", translatedChapters: 1, pendingTranslations: 0 },
    ]);
    expect(selectStatements()).toHaveLength(3);
  });
});
