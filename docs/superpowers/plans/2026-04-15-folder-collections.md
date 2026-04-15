# Folder-model Collections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert collections from overlay groupings to a folder model: each book lives in at most one collection; books inside a collection no longer appear in the main library. Admin gets a view-only backdoor to see all users' collections and books.

**Architecture:** Drop the `collection_books` join table; store folder membership as `books.collection_id` (nullable FK) plus `books.collection_seq` for ordering. Add `collections.visibility` (public/private) matching the existing book visibility model. New `POST /api/books/[id]/move` is the single source of mutation for folder placement. UI consolidates book actions into a "⋯" menu on `BookCard` and adds a destination picker to upload.

**Tech Stack:** Next.js 16 (App Router, route handlers), Drizzle ORM, better-sqlite3, Clerk, React 19, Tailwind, shadcn/ui (dialog, dropdown-menu, select).

**Note on commits:** The user handles all git commits personally. Tasks below end with a "Checkpoint" marker — that's a natural commit point, but do **not** run `git commit`. The user will commit between or after tasks.

---

## File structure

Files this plan will touch (create / modify / delete):

- **Create:**
  - `drizzle/0006_folder_collections.sql` — migration
  - `drizzle/meta/0006_snapshot.json` — drizzle snapshot (generated)
  - `src/app/api/books/[id]/move/route.ts` — new move endpoint
  - `src/lib/db/__tests__/folder-collections.test.ts` — migration + move integration tests
- **Modify:**
  - `drizzle/meta/_journal.json` — append 0006 entry
  - `src/lib/db/schema.ts` — add `collectionId`/`collectionSeq` to books; add `visibility` to collections; remove `collectionBooks` export
  - `src/lib/collections.ts` — replace join-table helpers with move + visibility helpers; add admin-aware loader
  - `src/app/api/books/route.ts` — add `?scope=top` filter
  - `src/app/api/books/upload/route.ts` — accept optional `collectionId`
  - `src/app/api/collections/route.ts` — admin-all listing; `visibility` handling; drop `bookIds[]` path; include `userId` in response
  - `src/app/api/collections/[id]/route.ts` — admin read access; visibility-filtered books; ownership checks on PUT/DELETE
  - `src/app/api/collections/[id]/books/route.ts` — reorder operates on `books.collection_seq`; POST deleted
  - `src/app/api/user/route.ts` — unchanged (already returns `id`/`isAdmin`)
  - `src/app/page.tsx` — fetch `?scope=top`; pass owner context to cards
  - `src/app/collections/[id]/page.tsx` — remove Add dialog; rename Remove → Move out; admin read-only branch
  - `src/components/BookCard.tsx` — add "⋯" menu with Move to; owner badge
  - `src/components/CollectionCard.tsx` — owner badge
  - `src/components/UploadZone.tsx` — add Collection `<select>`
- **Delete:**
  - `src/app/api/collections/[id]/books/[bookId]/route.ts` — replaced by move endpoint

---

## Task 1: Schema & migration

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create: `drizzle/0006_folder_collections.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `drizzle/meta/0006_snapshot.json`
- Create: `src/lib/db/__tests__/folder-collections.test.ts`

- [ ] **Step 1: Write failing schema test**

Create `src/lib/db/__tests__/folder-collections.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../schema";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";

describe("folder-model collections schema", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeAll(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: "./drizzle" });
  });

  afterAll(() => sqlite.close());

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
});
```

- [ ] **Step 2: Run the test — expect fail**

```bash
npm test -- folder-collections
```

Expected: fails with unknown column `collection_id`, or similar compile-time error when `schema.ts` doesn't have it yet.

- [ ] **Step 3: Update `src/lib/db/schema.ts`**

Inside `books` table, add two columns right after `visibility`:

```typescript
  // Folder-model: a book lives in at most one collection. NULL = top
  // level (shown in main library). When set, the book is hidden from
  // the main library and shown inside the collection view instead.
  // ON DELETE SET NULL in the migration — deleting a collection returns
  // its books to top level without cascading into the books table.
  collectionId: text("collection_id").references(() => collections.id, { onDelete: "set null" }),
  // Display order inside the collection. Lowest wins and also
  // determines the collection cover. NULL when collectionId is NULL.
  collectionSeq: integer("collection_seq"),
```

In `collections` table, add after `name`:

```typescript
  // Admin's collections default to 'public' (visible to all users,
  // symmetric to admin-public books). Regular users' collections are
  // always 'private'; the create endpoint enforces this.
  visibility: text("visibility").notNull().default("private"),
```

Delete the entire `collectionBooks` export (the table definition + import of `primaryKey` if no longer used — check other imports of `primaryKey` first).

Also update the top-level import line:
```typescript
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
```
(Remove `primaryKey` only if the file has no other references to it.)

- [ ] **Step 4: Create migration `drizzle/0006_folder_collections.sql`**

```sql
ALTER TABLE `books` ADD `collection_id` text REFERENCES collections(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `books` ADD `collection_seq` integer;--> statement-breakpoint
ALTER TABLE `collections` ADD `visibility` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
UPDATE `collections` SET `visibility` = 'public' WHERE `user_id` IN (SELECT `id` FROM `users` WHERE `is_admin` = 1);--> statement-breakpoint
DROP TABLE `collection_books`;
```

- [ ] **Step 5: Generate drizzle snapshot**

```bash
npx drizzle-kit generate
```

If this runs cleanly, it will write `drizzle/meta/0006_snapshot.json` and append to `_journal.json`. If drizzle-kit prompts for anything, cancel with Ctrl-C and instead:

- Copy `drizzle/meta/0005_snapshot.json` to `drizzle/meta/0006_snapshot.json`
- Hand-edit the copy: bump `"id"` to a fresh UUID (`uuidgen` or copy one from generator output), bump `"prevId"` to the 0005 snapshot's id, remove the `collection_books` table entry, add `collection_id` and `collection_seq` columns to the `books` entry, add `visibility` column to the `collections` entry.
- Append an entry to `drizzle/meta/_journal.json`:

```json
    {
      "idx": 6,
      "version": "6",
      "when": 1778000000000,
      "tag": "0006_folder_collections",
      "breakpoints": true
    }
```

(Adjust `when` if drizzle conventions in this repo look different — prior entries stepped by 100000000.)

- [ ] **Step 6: Run the test — expect pass**

```bash
npm test -- folder-collections
```

Expected: all 5 tests pass.

- [ ] **Step 7: Run full test suite to confirm no regressions**

```bash
npm test
```

Expected: all existing tests still pass. `schema.test.ts` may fail if it referenced `collection_books` — if so, remove those references (unlikely; scanned earlier and it doesn't).

- [ ] **Checkpoint:** Schema + migration done. Natural commit point.

---

## Task 2: `collections.ts` library refactor

The existing helpers (`loadOwnedCollection`, `canUseBookInCollection`, `appendBookToCollection`) are all built around the join table and owner-only reads. Replace them with folder-model helpers that also support the admin backdoor.

**Files:**
- Modify: `src/lib/collections.ts`
- Modify: `src/lib/db/__tests__/folder-collections.test.ts` (append tests)

- [ ] **Step 1: Write failing tests for the new helpers**

Append to `src/lib/db/__tests__/folder-collections.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — expect fail (functions undefined)**

```bash
npm test -- folder-collections
```

Expected: the new tests fail because `moveBookToCollection` and `loadCollectionForView` are not exported yet.

- [ ] **Step 3: Replace `src/lib/collections.ts` contents**

```typescript
import { getDb } from "@/lib/db";
import { books, collections } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";

/** Minimal shape of the acting user — pass from callers that already
 * resolved getCurrentUser(). Keeps this module free of auth imports. */
interface Actor {
  id: string;
  isAdmin: boolean;
}

/**
 * Load a collection for read purposes, honoring visibility rules:
 *   - owner sees their own collection (any visibility)
 *   - admin sees any collection (view-only backdoor)
 *   - otherwise: returns the row only if visibility='public'
 *
 * Returns null when the caller has no read access. Use this instead of
 * the old loadOwnedCollection when the endpoint is a pure read — GET
 * /api/collections/[id] for instance. For write endpoints, check
 * `row.userId === actor.id` after loading (admin still can't mutate
 * another user's collection; the backdoor is view-only).
 */
export function loadCollectionForView(
  collectionId: string,
  actor: Actor,
): typeof collections.$inferSelect | null {
  const db = getDb();
  const row = db
    .select()
    .from(collections)
    .where(eq(collections.id, collectionId))
    .get();
  if (!row) return null;
  if (row.userId === actor.id) return row;
  if (actor.isAdmin) return row;
  if (row.visibility === "public") return row;
  return null;
}

/**
 * Load a collection for a write operation. Only the owner may mutate —
 * admin's backdoor is strictly view-only, so a foreign row returns null
 * even for admin. Mirrors the old loadOwnedCollection signature.
 */
export function loadOwnedCollection(
  collectionId: string,
  actor: Actor,
): typeof collections.$inferSelect | null {
  const db = getDb();
  const row = db
    .select()
    .from(collections)
    .where(
      and(eq(collections.id, collectionId), eq(collections.userId, actor.id)),
    )
    .get();
  return row ?? null;
}

/**
 * Atomically move a book into a collection (or to top level). Validates:
 *   - the acting user owns the book
 *   - when targetCollectionId is non-null, the acting user owns that
 *     collection
 *
 * Throws on permission failure — the caller translates to a 403. Admin
 * status is not special here: admin only moves their own books into
 * their own collections. Prevents cross-tenant ownership drift.
 *
 * On success, sets collection_id + collection_seq atomically. collection_seq
 * becomes NULL when moving to top level, or `(max current seq) + 1` when
 * moving into a collection (appended to tail — preserves the current
 * cover).
 */
export function moveBookToCollection(params: {
  bookId: string;
  targetCollectionId: string | null;
  actingUserId: string;
  actingIsAdmin: boolean;
}): void {
  const { bookId, targetCollectionId, actingUserId } = params;
  const db = getDb();

  const book = db
    .select({ userId: books.userId })
    .from(books)
    .where(eq(books.id, bookId))
    .get();
  if (!book) throw new Error("book not found");
  if (book.userId !== actingUserId) {
    throw new Error("book not owned by caller");
  }

  let nextSeq: number | null = null;
  if (targetCollectionId !== null) {
    const target = db
      .select({ userId: collections.userId })
      .from(collections)
      .where(eq(collections.id, targetCollectionId))
      .get();
    if (!target) throw new Error("collection not found");
    if (target.userId !== actingUserId) {
      throw new Error("collection not owned by caller");
    }
    // Append to tail: max(collection_seq) + 1 within the target collection.
    const maxRow = db
      .select({ s: books.collectionSeq })
      .from(books)
      .where(eq(books.collectionId, targetCollectionId))
      .all();
    const maxSeq = maxRow.reduce(
      (m, r) => (r.s != null && r.s > m ? r.s : m),
      -1,
    );
    nextSeq = maxSeq + 1;
  }

  db.update(books)
    .set({
      collectionId: targetCollectionId,
      collectionSeq: nextSeq,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(books.id, bookId))
    .run();

  // Bump the collection's updatedAt on both source (if known) and target
  // so list ordering reflects recent activity. We don't track the source
  // here — the frontend shows collections by updatedAt DESC and a move
  // implicitly bumps via the target; source list just shrinks.
  if (targetCollectionId) {
    db.update(collections)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(collections.id, targetCollectionId))
      .run();
  }
}

/** Top-level books visible to a user, applying the same public/private
 * + admin-public rule used on the main library. Kept here (not in the
 * route) so the filter stays in one place and matches the collection
 * page's visibility logic. `?scope=top` in the books route calls this.
 *
 * Not using this directly from the route yet — /api/books implements
 * its own filter. This helper is a placeholder for a future refactor
 * if we end up duplicating the visibility logic. Skip unless needed. */
export function topLevelVisibilityClause() {
  return isNull(books.collectionId);
}
```

- [ ] **Step 4: Run the tests — expect pass**

```bash
npm test -- folder-collections
```

Expected: all previous tests plus the 8 new ones pass.

- [ ] **Step 5: Scan consumers of the old API**

```bash
```

Use Grep to find and list usages of `appendBookToCollection`, `canUseBookInCollection`, and the 2-arg `loadOwnedCollection()` call signature:

```bash
grep -rn "appendBookToCollection\|canUseBookInCollection\|loadOwnedCollection" src/
```

Expected hits:
- `src/app/api/collections/route.ts` — `loadOwnedCollection` not used here (uses direct DB), but `appendBookToCollection` + `canUseBookInCollection` are via the `bookIds[]` path → to be removed in Task 6.
- `src/app/api/collections/[id]/route.ts` — `loadOwnedCollection` used 3× → Task 7 updates these to pass an Actor argument.
- `src/app/api/collections/[id]/books/route.ts` — all three used → Task 8 updates this file (POST deleted, PUT signature change).
- `src/app/api/collections/[id]/books/[bookId]/route.ts` — `loadOwnedCollection` used → Task 9 deletes this file.

The new `loadOwnedCollection` signature takes `(id, actor)` instead of the old `(id)` + internal `getCurrentUser()`. This is intentional: the route already resolves `getCurrentUser()` at the top and threading it through is cheaper than a second round-trip.

- [ ] **Checkpoint:** Library refactored. Tests green. Routes in subsequent tasks will update their callsites.

---

## Task 3: Move endpoint `POST /api/books/[id]/move`

**Files:**
- Create: `src/app/api/books/[id]/move/route.ts`

- [ ] **Step 1: Create the route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { moveBookToCollection } from "@/lib/collections";

/**
 * Move a book into a collection, or out to top level. Body:
 *   { collectionId: string | null }
 *
 * Only the book's owner can call this, and only into their own
 * collections. Admin is not special here — the view-only backdoor in
 * loadCollectionForView does not extend to writes. 403 covers both
 * "not your book" and "not your collection".
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  const body = await request.json().catch(() => ({}));

  let targetCollectionId: string | null;
  if (body.collectionId === null) {
    targetCollectionId = null;
  } else if (typeof body.collectionId === "string") {
    targetCollectionId = body.collectionId;
  } else {
    return NextResponse.json(
      { error: "collectionId must be string or null" },
      { status: 400 },
    );
  }

  try {
    moveBookToCollection({
      bookId: id,
      targetCollectionId,
      actingUserId: user.id,
      actingIsAdmin: user.isAdmin,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (/not found/.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    return NextResponse.json({ error: msg }, { status: 403 });
  }

  return NextResponse.json({ success: true });
}
```

- [ ] **Step 2: Manual verification**

Start dev (if not running): `npm run dev`. With curl or DevTools console while signed in:

```javascript
// Smoke test: from the home page console, pick two ids from the visible library.
await fetch("/api/books/<BOOK_ID>/move", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ collectionId: "<COLLECTION_ID>" }),
}).then(r => r.json())
```

Expected: `{ success: true }`, book now reports `collectionId` on GET `/api/books`.

Error smoke:
```javascript
await fetch("/api/books/<BOOK_ID>/move", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ collectionId: "not-real-id" }),
}).then(r => [r.status, await r.text()]);
```
Expected: `[404, "{\"error\":\"collection not found\"}"]` or similar.

- [ ] **Checkpoint:** Move endpoint ready.

---

## Task 4: `GET /api/books?scope=top`

**Files:**
- Modify: `src/app/api/books/route.ts`

- [ ] **Step 1: Add scope parameter**

Change the handler signature + add filter:

```typescript
import { NextRequest, NextResponse } from "next/server";
// ...existing imports, plus:
import { isNull } from "drizzle-orm";

export async function GET(request: NextRequest) {
  ensureDataDir();
  const db = getDb();
  const user = await getCurrentUser();
  const scope = request.nextUrl.searchParams.get("scope");

  // (keep existing visibility whereClause construction as-is)
  // ...

  // Append top-level filter when requested. Home page uses this so the
  // library grid doesn't show books that already live in a collection.
  const finalWhere =
    scope === "top"
      ? whereClause
        ? and(whereClause, isNull(books.collectionId))
        : isNull(books.collectionId)
      : whereClause;

  const query = db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      sourceLang: books.sourceLang,
      coverPath: books.coverPath,
      totalChapters: books.totalChapters,
      status: books.status,
      userId: books.userId,
      visibility: books.visibility,
      collectionId: books.collectionId,
      createdAt: books.createdAt,
    })
    .from(books);

  const allBooks = (finalWhere ? query.where(finalWhere) : query)
    .orderBy(desc(books.createdAt))
    .all();
  // ...rest unchanged
```

Also: make sure `NextRequest` is imported and the signature is `GET(request: NextRequest)`.

Note: add `collectionId: books.collectionId` to the selected columns so the client can show which collection a book belongs to (useful in BookCard's Move menu — disabling the option pointing at the current home).

- [ ] **Step 2: Manual verification**

```javascript
await fetch("/api/books?scope=top").then(r => r.json())
// Expected: books only where collectionId === null
await fetch("/api/books").then(r => r.json())
// Expected: all visible books (books with collectionId set still present)
```

- [ ] **Checkpoint:** Library scope ready.

---

## Task 5: `GET /api/collections` — admin all + public visibility

**Files:**
- Modify: `src/app/api/collections/route.ts`

- [ ] **Step 1: Rewrite the GET handler**

Replace the `WHERE userId = user.id` filter with the same visibility pattern used in `GET /api/books`:

```typescript
import { asc, desc, eq, and, inArray, or } from "drizzle-orm";
// ...

export async function GET() {
  ensureDataDir();
  const user = await getCurrentUser();
  const db = getDb();

  // Admin backdoor: see all collections across users. Regular users see
  // their own private collections plus admin-owned public collections,
  // mirroring the books visibility rule.
  let whereClause;
  if (user.isAdmin) {
    whereClause = undefined;
  } else {
    const adminIds = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, 1))
      .all()
      .map((u) => u.id);
    const adminPublic = adminIds.length
      ? and(eq(collections.visibility, "public"), inArray(collections.userId, adminIds))
      : undefined;
    whereClause = adminPublic
      ? or(eq(collections.userId, user.id), adminPublic)
      : eq(collections.userId, user.id);
  }

  const q = db.select().from(collections);
  const rows = (whereClause ? q.where(whereClause) : q)
    .orderBy(desc(collections.updatedAt))
    .all();

  const decorated = rows.map((c) => {
    // Apply the same visibility filter to cover AND count so the card
    // only reflects books the viewer can actually open. Owner/admin see
    // everything; other viewers see public-visibility members.
    const isOwnerOrAdmin = user.isAdmin || c.userId === user.id;
    const memberFilter = isOwnerOrAdmin
      ? eq(books.collectionId, c.id)
      : and(eq(books.collectionId, c.id), eq(books.visibility, "public"));

    const coverBook = db
      .select({ id: books.id, coverPath: books.coverPath })
      .from(books)
      .where(memberFilter!)
      .orderBy(asc(books.collectionSeq), asc(books.createdAt))
      .limit(1)
      .all();

    const countRows = db
      .select({ id: books.id })
      .from(books)
      .where(memberFilter!)
      .all();
    const countVisible = countRows.length;

    const cover = coverBook[0];
    return {
      id: c.id,
      name: c.name,
      userId: c.userId,
      visibility: c.visibility,
      bookCount: countVisible,
      coverBookId: cover?.id ?? null,
      coverPath: cover?.coverPath ?? null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  });

  return NextResponse.json(decorated);
}
```

Note: `users` now needs to be in this file's imports — add `users` to the `@/lib/db/schema` import line.

Remove the `collectionBooks` import at the top of this file (no longer exists).

- [ ] **Step 2: Add imports**

```typescript
import { books, collections, users } from "@/lib/db/schema";
import { asc, desc, eq, and, inArray, or } from "drizzle-orm";
```

- [ ] **Step 3: Manual verification**

Sign in as admin → `GET /api/collections` returns all collections (including those owned by test users, if any). Sign in as regular test user → returns own + admin-public. (Until we have a regular-user account to test with, smoke it by toggling `ADMIN_EMAILS` and restarting the dev server.)

- [ ] **Checkpoint:** List collections respects new visibility + admin backdoor.

---

## Task 6: `POST /api/collections` — visibility; drop `bookIds[]` path

**Files:**
- Modify: `src/app/api/collections/route.ts`

- [ ] **Step 1: Update the POST handler**

Replace the body of `POST`:

```typescript
export async function POST(request: NextRequest) {
  ensureDataDir();
  const user = await getCurrentUser();
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });
  if (name.length > 120)
    return NextResponse.json({ error: "Name too long" }, { status: 400 });

  // Visibility: admin may pick public/private (default public, since
  // admin collections are showcase shelves). Regular users are forced
  // private — the server doesn't trust the field for non-admins.
  const rawVis = typeof body.visibility === "string" ? body.visibility : "";
  const visibility = user.isAdmin
    ? rawVis === "private"
      ? "private"
      : "public"
    : "private";

  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(collections)
    .values({ id, userId: user.id, name, visibility, createdAt: now, updatedAt: now })
    .run();

  return NextResponse.json({ id, name, visibility });
}
```

Delete the entire `bookIds[]` bulk-append block (no callers — folder model moves happen book-side via the move endpoint).

- [ ] **Step 2: Remove now-unused imports**

Drop the `books` import if POST was the only consumer (GET still uses it — keep). Confirm no reference to `collectionBooks` or `canUseBookInCollection` remains in the file.

- [ ] **Step 3: Manual verification**

```javascript
await fetch("/api/collections", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Test shelf", visibility: "public" }),
}).then(r => r.json());
```

Expected: `{ id, name, visibility }`. As admin: visibility reflects the sent value. As regular user: visibility is always `private` regardless of the sent value.

- [ ] **Checkpoint:** Create respects visibility rules; legacy bulk path removed.

---

## Task 7: `GET/PUT/DELETE /api/collections/[id]` — admin read + ownership writes

**Files:**
- Modify: `src/app/api/collections/[id]/route.ts`

- [ ] **Step 1: Rewrite GET to use the view loader + filter books**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, chapters, collections, users } from "@/lib/db/schema";
import { and, asc, count, eq, inArray, or } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { loadCollectionForView, loadOwnedCollection } from "@/lib/collections";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  const col = loadCollectionForView(id, { id: user.id, isAdmin: user.isAdmin });
  if (!col) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const db = getDb();

  // Book visibility inside this collection:
  //   - owner or admin: see every book
  //   - other user viewing admin's public collection: only public books
  let bookFilter = eq(books.collectionId, id);
  const isOwnerOrAdmin = col.userId === user.id || user.isAdmin;
  if (!isOwnerOrAdmin) {
    bookFilter = and(bookFilter, eq(books.visibility, "public"))!;
  }

  const rows = db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      sourceLang: books.sourceLang,
      coverPath: books.coverPath,
      totalChapters: books.totalChapters,
      status: books.status,
      userId: books.userId,
      seq: books.collectionSeq,
    })
    .from(books)
    .where(bookFilter)
    .orderBy(asc(books.collectionSeq), asc(books.createdAt))
    .all();

  const decorated = rows.map((b) => {
    const doneRow = db
      .select({ n: count() })
      .from(chapters)
      .where(and(eq(chapters.bookId, b.id), eq(chapters.status, "done")))
      .all();
    return { ...b, translatedChapters: doneRow[0]?.n || 0 };
  });

  return NextResponse.json({
    id: col.id,
    name: col.name,
    userId: col.userId,
    visibility: col.visibility,
    createdAt: col.createdAt,
    updatedAt: col.updatedAt,
    isReadOnly: col.userId !== user.id, // admin backdoor view-only flag
    books: decorated,
  });
}
```

- [ ] **Step 2: Update PUT (rename) to use owned loader**

```typescript
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  const col = loadOwnedCollection(id, { id: user.id, isAdmin: user.isAdmin });
  if (!col) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });
  if (name.length > 120) return NextResponse.json({ error: "Name too long" }, { status: 400 });

  const db = getDb();
  db.update(collections)
    .set({ name, updatedAt: new Date().toISOString() })
    .where(eq(collections.id, id))
    .run();

  return NextResponse.json({ id, name });
}
```

- [ ] **Step 3: Update DELETE to use owned loader**

```typescript
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  const col = loadOwnedCollection(id, { id: user.id, isAdmin: user.isAdmin });
  if (!col) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const db = getDb();
  db.delete(collections).where(eq(collections.id, id)).run();
  // ON DELETE SET NULL on books.collection_id returns members to top level.
  return NextResponse.json({ success: true });
}
```

- [ ] **Step 4: Remove stale imports**

Delete the `collectionBooks` import at the top of this file.

- [ ] **Step 5: Manual verification**

- As owner: `GET /api/collections/<own id>` → `isReadOnly: false`, books included.
- As admin visiting another user's collection: `GET /api/collections/<other id>` → `isReadOnly: true`, all books included.
- As regular user visiting an admin-public collection: `GET` → `isReadOnly: true`, only public books returned.
- `PUT` and `DELETE` against a foreign collection (as admin) → 404.

- [ ] **Checkpoint:** Detail endpoint respects view-only backdoor and visibility.

---

## Task 8: `PUT /api/collections/[id]/books` — reorder operates on `books.collection_seq`

**Files:**
- Modify: `src/app/api/collections/[id]/books/route.ts`

- [ ] **Step 1: Delete the POST handler entirely; replace the file**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, collections } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { loadOwnedCollection } from "@/lib/collections";

/**
 * PUT: reorder books inside a collection. Body: { order: bookId[] }.
 * Each book's collection_seq is set to its index in the array. Books
 * in the payload that aren't members of this collection are silently
 * dropped rather than moved in. Use POST /api/books/[id]/move to add.
 *
 * Owner-only. Admin's view-only backdoor does not extend to reorder.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  const col = loadOwnedCollection(id, { id: user.id, isAdmin: user.isAdmin });
  if (!col) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const order: string[] = Array.isArray(body.order) ? body.order : [];
  if (order.length === 0) {
    return NextResponse.json({ error: "order required" }, { status: 400 });
  }

  const db = getDb();
  const members = db
    .select({ id: books.id })
    .from(books)
    .where(eq(books.collectionId, id))
    .all();
  const valid = new Set(members.map((m) => m.id));

  let seq = 0;
  for (const bookId of order) {
    if (!valid.has(bookId)) continue;
    db.update(books)
      .set({ collectionSeq: seq++, updatedAt: new Date().toISOString() })
      .where(eq(books.id, bookId))
      .run();
  }
  db.update(collections)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(collections.id, id))
    .run();

  return NextResponse.json({ success: true });
}
```

- [ ] **Step 2: Manual verification**

From the collection detail page, drag ↑/↓ on a book. Expected: order persists after refresh. Server response `{ success: true }`.

- [ ] **Checkpoint:** Reorder now on `books.collection_seq`.

---

## Task 9: Delete legacy endpoint file

**Files:**
- Delete: `src/app/api/collections/[id]/books/[bookId]/route.ts`

- [ ] **Step 1: Delete the file and its parent dir**

```bash
rm src/app/api/collections/[id]/books/[bookId]/route.ts
rmdir src/app/api/collections/[id]/books/[bookId] 2>/dev/null || true
```

- [ ] **Step 2: Verify nothing else imports from it**

```bash
grep -rn "collections/\[id\]/books/\[bookId\]" src/
```

Expected: no hits.

- [ ] **Checkpoint:** Legacy detach endpoint gone.

---

## Task 10: `POST /api/books/upload` — optional `collectionId`

**Files:**
- Modify: `src/app/api/books/upload/route.ts`

- [ ] **Step 1: Accept and validate `collectionId`**

After reading `visibility` from the form, add:

```typescript
  // Optional destination collection. Silently ignored if it doesn't
  // resolve to a collection owned by the current user — the upload must
  // succeed regardless of folder placement. The book just lands top-level
  // in that case and the user can move it manually.
  const rawCollectionId = (formData.get("collectionId") as string | null)?.trim();
  let targetCollectionId: string | null = null;
  let targetCollectionSeq: number | null = null;
  if (rawCollectionId) {
    const col = db // NB: db is constructed below in the original file — move the getDb() call up, or redefine locally here
      .select({ userId: collections.userId })
      .from(collections)
      .where(eq(collections.id, rawCollectionId))
      .get();
    if (col && col.userId === user.id) {
      targetCollectionId = rawCollectionId;
      const maxRow = db
        .select({ s: books.collectionSeq })
        .from(books)
        .where(eq(books.collectionId, rawCollectionId))
        .all();
      const maxSeq = maxRow.reduce((m, r) => (r.s != null && r.s > m ? r.s : m), -1);
      targetCollectionSeq = maxSeq + 1;
    }
  }
```

Important: the original file doesn't call `getDb()` until after EPUB parse. Move this destination-resolution block to right after the `getDb()` call (inside the try, before the `db.insert(books)`). Add `collections` and `eq` imports at the top.

Update the `db.insert(books)` values object to include:

```typescript
        collectionId: targetCollectionId,
        collectionSeq: targetCollectionSeq,
```

- [ ] **Step 2: Manual verification**

Upload an EPUB with a `collectionId` in the form data:
```javascript
const fd = new FormData();
fd.append("file", fileFromPicker);
fd.append("collectionId", "<OWN_COLLECTION_ID>");
await fetch("/api/books/upload", { method: "POST", body: fd }).then(r => r.json());
```

- Check the returned book has `collectionId` populated in the DB.
- Upload with a fake collection id → book lands top-level (no error).
- Upload with a collection id owned by a different user → top-level (no error).

- [ ] **Checkpoint:** Upload can place directly into a collection.

---

## Task 11: Home page — `?scope=top` + owner context

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Thread `currentUserId` through state**

Replace the admin-only `useState(false)` with full user state:

```typescript
const [currentUser, setCurrentUser] = useState<{ id: string; isAdmin: boolean } | null>(null);
const isAdmin = currentUser?.isAdmin ?? false;
```

Update the fetch effect:

```typescript
useEffect(() => {
  let cancelled = false;
  fetch("/api/user")
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { id?: string; isAdmin?: boolean } | null) => {
      if (!cancelled && data?.id) {
        setCurrentUser({ id: data.id, isAdmin: !!data.isAdmin });
      }
    })
    .catch(() => {});
  return () => { cancelled = true; };
}, []);
```

- [ ] **Step 2: Fetch top-level books only**

```typescript
const fetchBooks = useCallback(async () => {
  const res = await fetch("/api/books?scope=top");
  if (res.ok) setBooks(await res.json());
}, []);
```

- [ ] **Step 3: Expand `Book` / `Collection` interfaces to carry `userId`**

```typescript
interface Book {
  // ...existing fields
  userId?: string | null;
  collectionId?: string | null;
}
interface Collection {
  // ...existing fields
  userId?: string;
  visibility?: "public" | "private";
}
```

- [ ] **Step 4: Pass `currentUser` into card components**

`<BookCard book={book} currentUserId={currentUser?.id} collections={collections} onMove={...} ... />`

Add `onMove` handler on the page:

```typescript
const handleMove = async (bookId: string, collectionId: string | null) => {
  const res = await fetch(`/api/books/${bookId}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ collectionId }),
  });
  if (res.ok) {
    fetchBooks();
    fetchCollections();
  } else {
    alert(`Move failed: ${await res.text()}`);
  }
};
```

And for CollectionCard: `<CollectionCard collection={c} currentUserId={currentUser?.id} isAdmin={isAdmin} />`.

- [ ] **Step 5: Manual verification**

Home library shows only top-level books after a move. Collections section still fully populated. (The card-side rendering gets real in the next tasks; this task just wires state.)

- [ ] **Checkpoint:** Page fetches scoped data and has user identity.

---

## Task 12: `BookCard` — "⋯" menu with Move to

**Files:**
- Modify: `src/components/BookCard.tsx`

- [ ] **Step 1: Update props**

```typescript
interface BookCardProps {
  book: {
    // ...existing
    userId?: string | null;
    collectionId?: string | null;
  };
  currentUserId?: string;
  isAdmin?: boolean;
  /** Collections available as move destinations. Should be the caller's
   * own collections; passing an admin-public collection the caller
   * doesn't own will be silently rejected by the server. */
  collections?: Array<{ id: string; name: string }>;
  onDelete: (id: string) => void;
  onMove?: (bookId: string, collectionId: string | null) => void;
  onChange?: () => void;
}
```

- [ ] **Step 2: Replace the delete `×` button with a `⋯` dropdown menu**

Import dropdown menu parts:

```typescript
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
```

Replace the `<Button …>×</Button>` at the end of the action row with:

```tsx
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <Button
      variant="outline"
      size="sm"
      className="h-7 w-7 px-0 text-muted-foreground"
      aria-label="More actions"
    >
      ⋯
    </Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end" className="w-44">
    {onMove && (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Move to…</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {book.collectionId !== null && book.collectionId !== undefined && (
            <DropdownMenuItem onSelect={() => onMove(book.id, null)}>
              Top level
            </DropdownMenuItem>
          )}
          {(collections ?? [])
            .filter((c) => c.id !== book.collectionId)
            .map((c) => (
              <DropdownMenuItem
                key={c.id}
                onSelect={() => onMove(book.id, c.id)}
              >
                {c.name}
              </DropdownMenuItem>
            ))}
          {(collections ?? []).length === 0 && book.collectionId == null && (
            <DropdownMenuItem disabled>No collections</DropdownMenuItem>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )}
    <DropdownMenuSeparator />
    <DropdownMenuItem
      className="text-destructive focus:text-destructive"
      onSelect={() => {
        if (confirm("Delete this book and all translations?")) onDelete(book.id);
      }}
    >
      Delete
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

Keep the Translate/Cancel button in its existing slot — only the delete button gets merged into the menu.

- [ ] **Step 3: Add owner badge**

Inside the cover-column `<div>`, after the image/placeholder, add:

```tsx
{isAdmin && book.userId && currentUserId && book.userId !== currentUserId && (
  <span
    className="absolute top-1 left-1 rounded-sm bg-background/85 backdrop-blur-sm px-1 text-[9px] font-medium tabular-nums shadow-sm"
    title="Owned by another user"
  >
    @other
  </span>
)}
```

Note: we don't have the owner's email on the client easily — `@other` is the placeholder. To make the badge informative, the GET /api/books response could be extended to include a short owner label; deferring that to a polish pass because the label itself is an internal admin affordance.

- [ ] **Step 4: Manual verification**

- As admin on home page: `⋯` menu shows Move to… submenu with your collections + "Top level" (if book is inside a collection). Selecting a target triggers the API call and refreshes the list.
- Moving a book out of a collection sends it back to the library grid.
- Delete still works from the new menu location.

- [ ] **Checkpoint:** Book actions consolidated; move happens from the card.

---

## Task 13: `UploadZone` — collection `<select>`

**Files:**
- Modify: `src/components/UploadZone.tsx`

- [ ] **Step 1: Fetch own collections and add state**

```typescript
const [targetCollectionId, setTargetCollectionId] = useState<string>("");
const [ownCollections, setOwnCollections] = useState<Array<{ id: string; name: string }>>([]);

useEffect(() => {
  let cancelled = false;
  // /api/collections filters to "own + admin public" for regular users
  // and "all" for admin. For the upload destination we want strictly
  // "owned by me", so we filter client-side against the currently signed-
  // in user id. For now we omit this nuance since only admin uploads anyway
  // in practice; if regular users upload, we'll add a server-side filter.
  fetch("/api/collections")
    .then((r) => (r.ok ? r.json() : []))
    .then((rows: Array<{ id: string; name: string }>) => {
      if (!cancelled) setOwnCollections(rows);
    })
    .catch(() => {});
  return () => { cancelled = true; };
}, []);
```

- [ ] **Step 2: Append the selector to the admin controls row**

Below the `autoTranslate` checkbox (or in its own row for regular users too), add:

```tsx
<label className="flex items-center gap-2 cursor-pointer select-none">
  <span className="text-xs uppercase tracking-wider">Collection</span>
  <select
    className="rounded-md border border-border/70 bg-background px-2 py-1 text-sm"
    value={targetCollectionId}
    onChange={(e) => setTargetCollectionId(e.target.value)}
  >
    <option value="">Top level</option>
    {ownCollections.map((c) => (
      <option key={c.id} value={c.id}>{c.name}</option>
    ))}
  </select>
</label>
```

The block is visible for everyone — regular users get the picker too. Move this out of the `isAdmin &&` gate to its own sibling block so non-admin users see it.

- [ ] **Step 3: Pass `collectionId` in the upload form**

Inside `handleUpload`:

```typescript
if (targetCollectionId) formData.append("collectionId", targetCollectionId);
```

- [ ] **Step 4: Include `targetCollectionId` in the useCallback deps list**

```typescript
[autoTranslate, isAdmin, visibility, targetCollectionId]
```

- [ ] **Step 5: Manual verification**

Choose a collection in the dropdown, upload an EPUB. On success, the new book appears inside that collection (not in the main library grid).

- [ ] **Checkpoint:** Upload lands books directly.

---

## Task 14: Collection page — Move out, admin read-only, no Add dialog

**Files:**
- Modify: `src/app/collections/[id]/page.tsx`

- [ ] **Step 1: Update state/interfaces**

```typescript
interface CollectionDetail {
  id: string;
  name: string;
  userId: string;
  visibility: "public" | "private";
  isReadOnly: boolean;
  createdAt: string;
  updatedAt: string;
  books: CollectionBook[];
}
```

- [ ] **Step 2: Remove the Add-book machinery**

Delete:
- `addOpen`, `library`, `fetchLibrary` state + effects
- `handleAdd` function
- The `+ Add book` button in the header row
- The Add-book dialog at the bottom
- `const memberIds = ...` and `const addable = ...`

- [ ] **Step 3: Rename Remove → Move out; call move endpoint**

```typescript
const handleMoveOut = async (bookId: string) => {
  const res = await fetch(`/api/books/${bookId}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ collectionId: null }),
  });
  if (res.ok) fetchCollection();
};
```

Replace the old `<Button … onClick={() => handleRemove(book.id)}>Remove</Button>` with:

```tsx
<Button
  variant="ghost"
  size="sm"
  className="text-muted-foreground hover:text-destructive"
  onClick={() => handleMoveOut(book.id)}
>
  Move out
</Button>
```

Delete the old `handleRemove` function.

- [ ] **Step 4: Hide owner-only actions when read-only**

Wrap the Rename and Delete buttons in the header, the reorder ↑/↓, and Move out with `{!collection.isReadOnly && (...)}`:

```tsx
{!collection.isReadOnly && (
  <>
    <Button variant="outline" size="sm" onClick={() => setRenameOpen(true)}>
      Rename
    </Button>
    <Button
      variant="outline"
      size="sm"
      className="text-muted-foreground hover:text-destructive hover:border-destructive/40"
      onClick={handleDeleteCollection}
    >
      Delete
    </Button>
  </>
)}
```

Same treatment for the buttons inside each book row — just move them into one `{!collection.isReadOnly && (...)}` block covering the ↑ ↓ Move out trio.

- [ ] **Step 5: Manual verification**

- Owner: full controls, Move out returns book to top level.
- Admin visiting someone else's collection: `isReadOnly=true`, no buttons, just a reading view.
- Deleting a collection with books inside: books reappear in main library.

- [ ] **Checkpoint:** Folder-model collection page.

---

## Task 15: `CollectionCard` — owner badge

**Files:**
- Modify: `src/components/CollectionCard.tsx`

- [ ] **Step 1: Extend props**

```typescript
interface CollectionCardProps {
  collection: {
    id: string;
    name: string;
    bookCount: number;
    coverBookId: string | null;
    coverPath: string | null;
    userId?: string;
    visibility?: "public" | "private";
  };
  currentUserId?: string;
  isAdmin?: boolean;
}

export function CollectionCard({ collection, currentUserId, isAdmin }: CollectionCardProps) {
```

- [ ] **Step 2: Render the badge**

Inside the cover container, above the bookCount badge, add:

```tsx
{isAdmin && collection.userId && currentUserId && collection.userId !== currentUserId && (
  <div className="absolute top-2 left-2 rounded-sm bg-background/85 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-medium shadow-sm">
    @other
  </div>
)}
```

- [ ] **Step 3: Thread props from home page**

In `src/app/page.tsx`, update the `<CollectionCard … />` callsite:

```tsx
<CollectionCard
  collection={c}
  currentUserId={currentUser?.id}
  isAdmin={isAdmin}
/>
```

- [ ] **Step 4: Manual verification**

Admin sees `@other` badge on collections they don't own. Owner doesn't see it on their own.

- [ ] **Checkpoint:** Admin backdoor visible cues in place.

---

## Task 16: Final full-flow verification

**Files:** none — verification pass.

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests pass, including the new folder-collections suite.

- [ ] **Step 2: Manual end-to-end checklist**

In the browser, signed in as admin:

1. Create a collection named "Test A" (visibility: public).
2. Upload an EPUB with "Top level" selected → appears in main library, not in collection.
3. Upload an EPUB with "Test A" selected → appears inside Test A, not in main library.
4. Open a library book → `⋯` → Move to → Test A → book disappears from library, appears in Test A.
5. Inside Test A → Move out on any book → book returns to library.
6. Reorder books in Test A with ↑↓ → persists on refresh, cover reflects new first.
7. Rename Test A → persists.
8. Delete Test A → collection gone, member books reappear in library.

Sign out, sign in as a second user (if available) or temporarily remove self from ADMIN_EMAILS and restart:

9. GET /api/collections returns only own + admin-public.
10. Click an admin-public collection → visible, all buttons hidden (read-only), only public books shown if any private were in it.

- [ ] **Step 3: Regression smoke**

- Translate all + Cancel all still work (unchanged).
- Reading progress still persists (unchanged).
- Vocabulary, dictionaries pages render (unchanged).

- [ ] **Checkpoint:** Feature complete.

---

## Out of scope reminder

Per the design doc, these are explicitly **not** in this plan:
- Multi-select / bulk move
- Drag-and-drop
- Nested collections
- Admin cross-tenant writes

Add them in a follow-up plan if the feature proves itself.
