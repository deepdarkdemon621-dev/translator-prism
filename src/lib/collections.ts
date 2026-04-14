import { getDb } from "@/lib/db";
import { books, collections, collectionBooks } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { getCurrentUser, type SessionUser } from "@/lib/auth";

/**
 * Return the collection if the current caller owns it, otherwise null.
 * Collections are per-user — admin doesn't get a cross-tenant view,
 * by design. Returns the user too so the caller doesn't need a second
 * getCurrentUser() round-trip.
 */
export async function loadOwnedCollection(collectionId: string): Promise<{
  user: SessionUser;
  collection: typeof collections.$inferSelect | null;
}> {
  const user = await getCurrentUser();
  const db = getDb();
  const col = db
    .select()
    .from(collections)
    .where(
      and(
        eq(collections.id, collectionId),
        eq(collections.userId, user.id),
      ),
    )
    .get();
  return { user, collection: col ?? null };
}

/**
 * Visibility rule for adding a book to a collection: a user can add
 * any book they can see in their library (own + public). Admin can
 * add anything. Prevents users from linking against a stranger's
 * private upload just because they guessed the id.
 */
export function canUseBookInCollection(
  user: SessionUser,
  bookId: string,
): boolean {
  const db = getDb();
  const book = db
    .select({ userId: books.userId, visibility: books.visibility })
    .from(books)
    .where(eq(books.id, bookId))
    .get();
  if (!book) return false;
  if (user.isAdmin) return true;
  if (book.userId === user.id) return true;
  return book.visibility === "public";
}

/**
 * Append a book to the tail of a collection. seq gets set to
 * (current max seq) + 1 so the new row lands last. No-ops on conflict
 * (same book re-added) so the endpoint is idempotent from the caller's
 * perspective.
 */
export function appendBookToCollection(
  collectionId: string,
  bookId: string,
): void {
  const db = getDb();
  const rows = db
    .select({ seq: collectionBooks.seq })
    .from(collectionBooks)
    .where(eq(collectionBooks.collectionId, collectionId))
    .all();
  const maxSeq = rows.reduce((m, r) => (r.seq > m ? r.seq : m), -1);
  db.insert(collectionBooks)
    .values({
      collectionId,
      bookId,
      seq: maxSeq + 1,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
}
