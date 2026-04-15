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
export async function loadCollectionForView(
  collectionId: string,
  actor: Actor,
): Promise<typeof collections.$inferSelect | null> {
  const db = getDb();
  const row = await db
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
export async function loadOwnedCollection(
  collectionId: string,
  actor: Actor,
): Promise<typeof collections.$inferSelect | null> {
  const db = getDb();
  const row = await db
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
export async function moveBookToCollection(params: {
  bookId: string;
  targetCollectionId: string | null;
  actingUserId: string;
  actingIsAdmin: boolean;
}): Promise<void> {
  const { bookId, targetCollectionId, actingUserId } = params;
  const db = getDb();

  const book = await db
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
    const target = await db
      .select({ userId: collections.userId })
      .from(collections)
      .where(eq(collections.id, targetCollectionId))
      .get();
    if (!target) throw new Error("collection not found");
    if (target.userId !== actingUserId) {
      throw new Error("collection not owned by caller");
    }
    // Append to tail: max(collection_seq) + 1 within the target collection.
    const maxRow = await db
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

  await db
    .update(books)
    .set({
      collectionId: targetCollectionId,
      collectionSeq: nextSeq,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(books.id, bookId))
    .run();

  // Bump the collection's updatedAt on the target so list ordering
  // reflects recent activity. Source collection is not updated here —
  // if needed later, a move helper could read the old collection_id
  // first and touch both.
  if (targetCollectionId) {
    await db
      .update(collections)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(collections.id, targetCollectionId))
      .run();
  }
}

/** Top-level books clause for the main library view. Kept here so the
 * filter stays in one place alongside other visibility helpers. */
export function topLevelVisibilityClause() {
  return isNull(books.collectionId);
}
