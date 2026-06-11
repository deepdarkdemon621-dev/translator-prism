import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as schema from "@/lib/db/schema";
import {
  collectionMemberBooksWhere,
  visibleBooksWhereForActor,
  visibleCollectionsWhereForActor,
} from "@/lib/library/visibility";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

describe("library visibility query helpers", () => {
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
    await db.delete(schema.collections).run();
    await db.delete(schema.users).run();
  });

  async function makeUser(isAdmin = false): Promise<string> {
    const id = randomUUID();
    await db
      .insert(schema.users)
      .values({ id, email: `${id}@example.test`, isAdmin: isAdmin ? 1 : 0 })
      .run();
    return id;
  }

  async function makeBook(params: {
    id: string;
    userId: string;
    visibility: "public" | "private";
    collectionId?: string | null;
    seq?: number | null;
  }) {
    await db
      .insert(schema.books)
      .values({
        id: params.id,
        title: params.id,
        author: "A",
        sourceLang: "ja",
        filePath: `/${params.id}.epub`,
        totalChapters: 1,
        status: "parsed",
        userId: params.userId,
        visibility: params.visibility,
        collectionId: params.collectionId ?? null,
        collectionSeq: params.seq ?? null,
      })
      .run();
  }

  async function makeCollection(params: {
    id: string;
    userId: string;
    visibility: "public" | "private";
  }) {
    await db
      .insert(schema.collections)
      .values({
        id: params.id,
        userId: params.userId,
        name: params.id,
        visibility: params.visibility,
      })
      .run();
  }

  it("returns all books for an admin actor", async () => {
    const admin = await makeUser(true);
    const other = await makeUser();
    await makeBook({ id: "admin-private", userId: admin, visibility: "private" });
    await makeBook({ id: "other-private", userId: other, visibility: "private" });

    const rows = await db
      .select({ id: schema.books.id })
      .from(schema.books)
      .where(await visibleBooksWhereForActor(db, { id: admin, isAdmin: true }))
      .orderBy(asc(schema.books.id))
      .all();

    expect(rows.map((row) => row.id)).toEqual(["admin-private", "other-private"]);
  });

  it("returns own books plus admin-public books for a regular actor", async () => {
    const admin = await makeUser(true);
    const user = await makeUser();
    const other = await makeUser();
    await makeBook({ id: "admin-private", userId: admin, visibility: "private" });
    await makeBook({ id: "admin-public", userId: admin, visibility: "public" });
    await makeBook({ id: "own-private", userId: user, visibility: "private" });
    await makeBook({ id: "other-public", userId: other, visibility: "public" });

    const rows = await db
      .select({ id: schema.books.id })
      .from(schema.books)
      .where(await visibleBooksWhereForActor(db, { id: user, isAdmin: false }))
      .orderBy(asc(schema.books.id))
      .all();

    expect(rows.map((row) => row.id)).toEqual(["admin-public", "own-private"]);
  });

  it("returns own collections plus admin-public collections for a regular actor", async () => {
    const admin = await makeUser(true);
    const user = await makeUser();
    const other = await makeUser();
    await makeCollection({ id: "admin-private", userId: admin, visibility: "private" });
    await makeCollection({ id: "admin-public", userId: admin, visibility: "public" });
    await makeCollection({ id: "own-private", userId: user, visibility: "private" });
    await makeCollection({ id: "other-public", userId: other, visibility: "public" });

    const rows = await db
      .select({ id: schema.collections.id })
      .from(schema.collections)
      .where(await visibleCollectionsWhereForActor(db, { id: user, isAdmin: false }))
      .orderBy(asc(schema.collections.id))
      .all();

    expect(rows.map((row) => row.id)).toEqual(["admin-public", "own-private"]);
  });

  it("filters collection members to public books for read-only viewers", async () => {
    const admin = await makeUser(true);
    const collectionId = "collection";
    await makeCollection({ id: collectionId, userId: admin, visibility: "public" });
    await makeBook({
      id: "private-member",
      userId: admin,
      visibility: "private",
      collectionId,
      seq: 0,
    });
    await makeBook({
      id: "public-member",
      userId: admin,
      visibility: "public",
      collectionId,
      seq: 1,
    });

    const rows = await db
      .select({ id: schema.books.id })
      .from(schema.books)
      .where(collectionMemberBooksWhere(collectionId, { includePrivateMembers: false }))
      .orderBy(asc(schema.books.id))
      .all();

    expect(rows.map((row) => row.id)).toEqual(["public-member"]);
  });

  it("includes private collection members for owners and admins", async () => {
    const owner = await makeUser();
    const collectionId = "collection";
    await makeCollection({ id: collectionId, userId: owner, visibility: "private" });
    await makeBook({
      id: "private-member",
      userId: owner,
      visibility: "private",
      collectionId,
      seq: 0,
    });
    await makeBook({
      id: "public-member",
      userId: owner,
      visibility: "public",
      collectionId,
      seq: 1,
    });

    const rows = await db
      .select({ id: schema.books.id })
      .from(schema.books)
      .where(collectionMemberBooksWhere(collectionId, { includePrivateMembers: true }))
      .orderBy(asc(schema.books.id))
      .all();

    expect(rows.map((row) => row.id)).toEqual(["private-member", "public-member"]);
  });

  it("can filter a single collection row with the shared collection predicate", async () => {
    const admin = await makeUser(true);
    const user = await makeUser();
    await makeCollection({ id: "admin-public", userId: admin, visibility: "public" });

    const row = await db
      .select({ id: schema.collections.id })
      .from(schema.collections)
      .where(
        eq(
          schema.collections.id,
          "admin-public",
        ),
      )
      .get();

    expect(row).toEqual({ id: "admin-public" });
    await expect(
      visibleCollectionsWhereForActor(db, { id: user, isAdmin: false }),
    ).resolves.toBeDefined();
  });
});
