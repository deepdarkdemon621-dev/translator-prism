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

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!_testDb) throw new Error("test DB not initialised");
    return _testDb;
  },
}));

describe("moveBooksToCollectionBulk", () => {
  let db: TestDb;
  let owner: string;
  let other: string;

  beforeAll(async () => {
    client = createClient({ url: "file::memory:" });
    await migrate(drizzle(client, { schema }), { migrationsFolder: "./drizzle" });
    db = drizzle(client, { schema });
    _testDb = db;
  });

  afterAll(() => {
    _testDb = null;
    client.close();
  });

  beforeEach(async () => {
    await db.delete(schema.books).run();
    await db.delete(schema.collections).run();
    await db.delete(schema.users).run();
    owner = randomUUID();
    other = randomUUID();
    for (const id of [owner, other]) {
      await db.insert(schema.users).values({ id, email: `${id}@x` }).run();
    }
  });

  async function makeBook(id: string, userId: string, collectionId?: string, seq?: number) {
    await db.insert(schema.books).values({
      id,
      title: id,
      author: "A",
      sourceLang: "ja",
      filePath: `/${id}.epub`,
      userId,
      collectionId: collectionId ?? null,
      collectionSeq: seq ?? null,
    }).run();
  }

  async function makeCollection(id: string, userId: string) {
    await db.insert(schema.collections).values({ id, userId, name: id }).run();
  }

  async function bookRow(id: string) {
    return db.select().from(schema.books).where(eq(schema.books.id, id)).get();
  }

  it("appends books after the existing max seq preserving payload order", async () => {
    await makeCollection("col", owner);
    await makeBook("existing", owner, "col", 4);
    await makeBook("b1", owner);
    await makeBook("b2", owner);

    const { moveBooksToCollectionBulk } = await import("@/lib/collections");
    const res = await moveBooksToCollectionBulk({
      bookIds: ["b1", "b2"],
      targetCollectionId: "col",
      actingUserId: owner,
    });

    expect(res.succeeded).toEqual(["b1", "b2"]);
    expect(res.failed).toEqual([]);
    expect(await bookRow("b1")).toMatchObject({ collectionId: "col", collectionSeq: 5 });
    expect(await bookRow("b2")).toMatchObject({ collectionId: "col", collectionSeq: 6 });
    expect(await bookRow("existing")).toMatchObject({ collectionSeq: 4 });
  });

  it("reports per-book failures without aborting the rest", async () => {
    await makeCollection("col", owner);
    await makeBook("mine", owner);
    await makeBook("theirs", other);

    const { moveBooksToCollectionBulk } = await import("@/lib/collections");
    const res = await moveBooksToCollectionBulk({
      bookIds: ["missing", "theirs", "mine"],
      targetCollectionId: "col",
      actingUserId: owner,
    });

    expect(res.succeeded).toEqual(["mine"]);
    expect(res.failed).toEqual([
      { id: "missing", error: "book not found" },
      { id: "theirs", error: "book not owned by caller" },
    ]);
    expect(await bookRow("mine")).toMatchObject({ collectionId: "col", collectionSeq: 0 });
    expect(await bookRow("theirs")).toMatchObject({ collectionId: null });
  });

  it("moves books back to top level with null seq", async () => {
    await makeCollection("col", owner);
    await makeBook("b1", owner, "col", 0);

    const { moveBooksToCollectionBulk } = await import("@/lib/collections");
    const res = await moveBooksToCollectionBulk({
      bookIds: ["b1"],
      targetCollectionId: null,
      actingUserId: owner,
    });

    expect(res.succeeded).toEqual(["b1"]);
    expect(await bookRow("b1")).toMatchObject({ collectionId: null, collectionSeq: null });
  });

  it("fails every eligible book when the target collection is not owned", async () => {
    await makeCollection("their-col", other);
    await makeBook("b1", owner);

    const { moveBooksToCollectionBulk } = await import("@/lib/collections");
    const res = await moveBooksToCollectionBulk({
      bookIds: ["b1"],
      targetCollectionId: "their-col",
      actingUserId: owner,
    });

    expect(res.succeeded).toEqual([]);
    expect(res.failed).toEqual([
      { id: "b1", error: "collection not owned by caller" },
    ]);
    expect(await bookRow("b1")).toMatchObject({ collectionId: null });
  });
});
