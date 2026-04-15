import { getDb } from "@/lib/db";
import { books, chapters, chapterAccess, users } from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { SessionUser } from "@/lib/auth";

/**
 * Pricing model (phase-2 skeleton):
 *
 * - Public / showcase books are free. Admin pre-translates and everyone
 *   reads for nothing.
 * - Private books (user uploads) cost credits per chapter. Upload itself
 *   is free; the monetized action is translating + reading.
 * - Admins bypass everything.
 *
 * Pricing stays coarse and round for now — we can replace the constant
 * with a per-chapter token estimate once the upload flow computes one.
 */
export const CHAPTER_COST = 5;

/**
 * Bundle tiers displayed on the upload pricing screen. Discounts stack
 * only against a full-price baseline — a user who already owns a single
 * chapter and then buys the "first10" bundle gets charged only for the
 * remaining 9 (no retroactive refund on the single purchase).
 */
export const BUNDLE_TIERS = {
  first3: { chapters: 3, discountPct: 0 },
  first10: { chapters: 10, discountPct: 10 },
  full: { chapters: null as number | null, discountPct: 20 },
} as const;

export type BundleKey = keyof typeof BUNDLE_TIERS;

/**
 * Compute what a bundle would cost right now for a given book + user.
 * Pure-ish — reads DB but does not write — so routes and UI can both
 * call it to show an estimate before charging.
 */
export async function quoteBundle(
  user: SessionUser,
  bookId: string,
  bundle: BundleKey,
): Promise<{
  chapterIds: string[];
  alreadyOwned: number;
  newCharges: number;
  credits: number;
}> {
  const db = getDb();
  const tier = BUNDLE_TIERS[bundle];

  const baseQuery = db
    .select({ id: chapters.id })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(chapters.index);
  const chapterRows = await (tier.chapters == null
    ? baseQuery
    : baseQuery.limit(tier.chapters)
  ).all();
  const chapterIds = chapterRows.map((c) => c.id);

  if (chapterIds.length === 0) {
    return { chapterIds: [], alreadyOwned: 0, newCharges: 0, credits: 0 };
  }

  const owned = await db
    .select({ chapterId: chapterAccess.chapterId })
    .from(chapterAccess)
    .where(
      and(
        eq(chapterAccess.userId, user.id),
        inArray(chapterAccess.chapterId, chapterIds),
      ),
    )
    .all();
  const ownedSet = new Set(owned.map((o) => o.chapterId));

  const newCharges = chapterIds.filter((id) => !ownedSet.has(id)).length;
  const gross = newCharges * CHAPTER_COST;
  const credits = Math.ceil(gross * (1 - tier.discountPct / 100));

  return {
    chapterIds,
    alreadyOwned: ownedSet.size,
    newCharges,
    credits,
  };
}

/**
 * Cheap check used by read/translate routes. Returns true if the caller
 * is allowed to see/translate the chapter at all — admin, public book,
 * or paid chapter_access row.
 */
export async function hasChapterAccess(
  user: SessionUser,
  chapterId: string,
): Promise<boolean> {
  if (user.isAdmin) return true;
  const db = getDb();
  const chapter = await db
    .select({ bookId: chapters.bookId })
    .from(chapters)
    .where(eq(chapters.id, chapterId))
    .get();
  if (!chapter) return false;
  const book = await db
    .select({ visibility: books.visibility, userId: books.userId })
    .from(books)
    .where(eq(books.id, chapter.bookId))
    .get();
  if (!book) return false;
  // Public showcase books are free for everyone.
  if (book.visibility === "public") return true;
  // Private book, non-admin, non-public: need a paid row.
  const row = await db
    .select({ id: chapterAccess.id })
    .from(chapterAccess)
    .where(
      and(
        eq(chapterAccess.userId, user.id),
        eq(chapterAccess.chapterId, chapterId),
      ),
    )
    .get();
  return !!row;
}

export class InsufficientCreditsError extends Error {
  constructor(
    public required: number,
    public available: number,
  ) {
    super(`Insufficient credits: need ${required}, have ${available}`);
    this.name = "InsufficientCreditsError";
  }
}

/**
 * Debit the user's balance and insert chapter_access rows. NOT currently
 * atomic — libsql is a remote async driver and these writes are issued
 * one at a time, so a mid-sequence failure can leave the balance debited
 * without the matching chapter_access rows (or vice versa). Wrapping in
 * a real transaction is a follow-up. `chapterIds` that the user already
 * owns are silently skipped (not double-charged).
 *
 * Returns the actual credits spent and how many rows were newly granted.
 * Caller is responsible for having already verified that the book
 * belongs to the user (or that they're admin).
 */
export async function purchaseChapters(
  user: SessionUser,
  chapterIds: string[],
  options: { discountPct?: number } = {},
): Promise<{ creditsSpent: number; granted: number; alreadyOwned: number }> {
  const db = getDb();
  if (chapterIds.length === 0) {
    return { creditsSpent: 0, granted: 0, alreadyOwned: 0 };
  }

  // Admins "buy" at zero cost — we still insert rows so the rest of the
  // system can treat ownership uniformly.
  const discountPct = options.discountPct ?? 0;

  // Read-then-write window below is NOT protected against concurrent
  // purchases — two parallel requests from the same user could both pass
  // the balance check and double-spend. Wrap this body in a libsql
  // transaction (or a server-side lock) as a follow-up.

  const existing = await db
    .select({ chapterId: chapterAccess.chapterId })
    .from(chapterAccess)
    .where(
      and(
        eq(chapterAccess.userId, user.id),
        inArray(chapterAccess.chapterId, chapterIds),
      ),
    )
    .all();
  const ownedSet = new Set(existing.map((e) => e.chapterId));
  const toBuy = chapterIds.filter((id) => !ownedSet.has(id));

  if (toBuy.length === 0) {
    return { creditsSpent: 0, granted: 0, alreadyOwned: ownedSet.size };
  }

  const gross = toBuy.length * CHAPTER_COST;
  const creditsSpent = user.isAdmin
    ? 0
    : Math.ceil(gross * (1 - discountPct / 100));

  if (!user.isAdmin) {
    const row = await db
      .select({ credits: users.credits })
      .from(users)
      .where(eq(users.id, user.id))
      .get();
    const available = row?.credits ?? 0;
    if (available < creditsSpent) {
      throw new InsufficientCreditsError(creditsSpent, available);
    }
    await db
      .update(users)
      .set({
        credits: available - creditsSpent,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, user.id))
      .run();
  }

  const now = new Date().toISOString();
  // Spread the total charge evenly across rows for auditing — integer
  // division drops any remainder onto the first row so the sum matches.
  const perRow = toBuy.length > 0 ? Math.floor(creditsSpent / toBuy.length) : 0;
  const remainder = creditsSpent - perRow * toBuy.length;
  for (let i = 0; i < toBuy.length; i++) {
    await db
      .insert(chapterAccess)
      .values({
        id: randomUUID(),
        userId: user.id,
        chapterId: toBuy[i],
        creditsSpent: perRow + (i === 0 ? remainder : 0),
        createdAt: now,
      })
      .run();
  }

  return {
    creditsSpent,
    granted: toBuy.length,
    alreadyOwned: ownedSet.size,
  };
}

/**
 * Top-up: add credits to a user's balance. For now this is the only
 * source of credits; when Stripe/Alipay land, the webhook calls this
 * same function with a verified amount.
 */
export async function grantCredits(
  userId: string,
  amount: number,
): Promise<number> {
  if (amount <= 0) throw new Error("grantCredits amount must be positive");
  const db = getDb();
  const row = await db
    .select({ credits: users.credits })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!row) throw new Error("User not found");
  const next = row.credits + amount;
  await db
    .update(users)
    .set({ credits: next, updatedAt: new Date().toISOString() })
    .where(eq(users.id, userId))
    .run();
  return next;
}
