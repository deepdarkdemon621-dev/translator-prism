import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../schema";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";

// Module-level reference so the vi.mock factory (which is hoisted) can
// forward calls to the in-memory DB created in beforeAll.
let _testDb: ReturnType<typeof drizzle> | null = null;

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!_testDb) throw new Error("test DB not initialised");
    return _testDb;
  },
}));

describe("folder-model collections schema", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeAll(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: "./drizzle" });
    _testDb = db;
  });

  afterAll(() => {
    _testDb = null;
    sqlite.close();
  });

  function makeUser(isAdmin = 0): string {
    const id = randomUUID();
    db.insert(schema.users).values({ id, email: `${id}@x`, isAdmin }).run();
    return id;
  }

  function makeBook(userId: string, collectionId: string | null = null, seq: number | null = null) {
    const id = randomUUID();
    db.insert(schema.books).values({
      id, title: "T", author: "A", sourceLang: "ja",
      filePath: `/${id}.epub`, totalChapters: 1, status: "parsed",
      userId, collectionId, collectionSeq: seq,
    }).run();
    return id;
  }

  it("books have collection_id and collection_seq columns", () => {
    const u = makeUser();
    const c = randomUUID();
    db.insert(schema.collections).values({ id: c, userId: u, name: "S", visibility: "private" }).run();
    const b = makeBook(u, c, 0);

    const row = db.select().from(schema.books).where(eq(schema.books.id, b)).get();
    expect(row?.collectionId).toBe(c);
    expect(row?.collectionSeq).toBe(0);
  });

  it("collections have visibility column defaulting to private", () => {
    const u = makeUser();
    const id = randomUUID();
    db.insert(schema.collections).values({ id, userId: u, name: "x" }).run();
    const row = db.select().from(schema.collections).where(eq(schema.collections.id, id)).get();
    expect(row?.visibility).toBe("private");
  });

  it("deleting a collection sets member books' collection_id to NULL", () => {
    const u = makeUser();
    const c = randomUUID();
    db.insert(schema.collections).values({ id: c, userId: u, name: "S" }).run();
    const b = makeBook(u, c, 0);

    db.delete(schema.collections).where(eq(schema.collections.id, c)).run();

    const row = db.select().from(schema.books).where(eq(schema.books.id, b)).get();
    expect(row).toBeDefined();
    expect(row?.collectionId).toBeNull();
  });

  it("top-level books filter: collection_id IS NULL", () => {
    const u = makeUser();
    const c = randomUUID();
    db.insert(schema.collections).values({ id: c, userId: u, name: "S" }).run();
    makeBook(u, c, 0);
    const top = makeBook(u, null, null);

    const rows = db.select().from(schema.books)
      .where(and(eq(schema.books.userId, u), isNull(schema.books.collectionId)))
      .all();
    expect(rows.map((r) => r.id)).toEqual([top]);
  });

  it("collection_books table is dropped", () => {
    expect(() =>
      sqlite.prepare("SELECT * FROM collection_books").all(),
    ).toThrow(/no such table/i);
  });

  describe("moveBookToCollection", () => {
    it("appends to target tail and clears source", async () => {
      const { moveBookToCollection } = await import("@/lib/collections");
      const u = makeUser();
      const a = randomUUID(), b = randomUUID();
      db.insert(schema.collections).values([
        { id: a, userId: u, name: "A" },
        { id: b, userId: u, name: "B" },
      ]).run();
      const b1 = makeBook(u, a, 0);
      const b2 = makeBook(u, a, 1);
      const b3 = makeBook(u, b, 0);

      moveBookToCollection({ bookId: b2, targetCollectionId: b, actingUserId: u, actingIsAdmin: false });

      const moved = db.select().from(schema.books).where(eq(schema.books.id, b2)).get();
      expect(moved?.collectionId).toBe(b);
      expect(moved?.collectionSeq).toBe(1); // appended after b3 (seq 0)

      // Untouched
      const stay = db.select().from(schema.books).where(eq(schema.books.id, b1)).get();
      expect(stay?.collectionId).toBe(a);
    });

    it("move to top-level nulls both fields", async () => {
      const { moveBookToCollection } = await import("@/lib/collections");
      const u = makeUser();
      const c = randomUUID();
      db.insert(schema.collections).values({ id: c, userId: u, name: "A" }).run();
      const bk = makeBook(u, c, 0);

      moveBookToCollection({ bookId: bk, targetCollectionId: null, actingUserId: u, actingIsAdmin: false });

      const row = db.select().from(schema.books).where(eq(schema.books.id, bk)).get();
      expect(row?.collectionId).toBeNull();
      expect(row?.collectionSeq).toBeNull();
    });

    it("rejects moving someone else's book", async () => {
      const { moveBookToCollection } = await import("@/lib/collections");
      const u1 = makeUser(), u2 = makeUser();
      const c = randomUUID();
      db.insert(schema.collections).values({ id: c, userId: u2, name: "A" }).run();
      const bk = makeBook(u1, null, null);

      expect(() =>
        moveBookToCollection({ bookId: bk, targetCollectionId: c, actingUserId: u2, actingIsAdmin: false }),
      ).toThrow(/book/i);
    });

    it("rejects moving into someone else's collection", async () => {
      const { moveBookToCollection } = await import("@/lib/collections");
      const u1 = makeUser(), u2 = makeUser();
      const c = randomUUID();
      db.insert(schema.collections).values({ id: c, userId: u2, name: "A" }).run();
      const bk = makeBook(u1, null, null);

      expect(() =>
        moveBookToCollection({ bookId: bk, targetCollectionId: c, actingUserId: u1, actingIsAdmin: false }),
      ).toThrow(/collection/i);
    });

    it("admin can move admin's own book, but not across tenant", async () => {
      const { moveBookToCollection } = await import("@/lib/collections");
      const u1 = makeUser(), admin = makeUser(1);
      const c = randomUUID();
      db.insert(schema.collections).values({ id: c, userId: admin, name: "A" }).run();
      const adminBook = makeBook(admin, null, null);
      const userBook = makeBook(u1, null, null);

      // admin → own collection: ok
      moveBookToCollection({ bookId: adminBook, targetCollectionId: c, actingUserId: admin, actingIsAdmin: true });
      expect(db.select().from(schema.books).where(eq(schema.books.id, adminBook)).get()?.collectionId).toBe(c);

      // admin tries to move someone else's book: rejected
      expect(() =>
        moveBookToCollection({ bookId: userBook, targetCollectionId: c, actingUserId: admin, actingIsAdmin: true }),
      ).toThrow(/book/i);
    });
  });

  describe("loadCollectionForView", () => {
    it("owner gets their own collection", async () => {
      const { loadCollectionForView } = await import("@/lib/collections");
      const u = makeUser();
      const c = randomUUID();
      db.insert(schema.collections).values({ id: c, userId: u, name: "S", visibility: "private" }).run();

      const result = loadCollectionForView(c, { id: u, isAdmin: false });
      expect(result?.id).toBe(c);
    });

    it("regular user can read admin's public collection but not private", async () => {
      const { loadCollectionForView } = await import("@/lib/collections");
      const admin = makeUser(1), reader = makeUser();
      const pub = randomUUID(), priv = randomUUID();
      db.insert(schema.collections).values([
        { id: pub, userId: admin, name: "P", visibility: "public" },
        { id: priv, userId: admin, name: "X", visibility: "private" },
      ]).run();

      expect(loadCollectionForView(pub, { id: reader, isAdmin: false })?.id).toBe(pub);
      expect(loadCollectionForView(priv, { id: reader, isAdmin: false })).toBeNull();
    });

    it("admin backdoor: reads any collection regardless of visibility", async () => {
      const { loadCollectionForView } = await import("@/lib/collections");
      const other = makeUser(), admin = makeUser(1);
      const c = randomUUID();
      db.insert(schema.collections).values({ id: c, userId: other, name: "X", visibility: "private" }).run();

      expect(loadCollectionForView(c, { id: admin, isAdmin: true })?.id).toBe(c);
    });
  });
});
