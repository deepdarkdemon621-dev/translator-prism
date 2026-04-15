import { auth, currentUser } from "@clerk/nextjs/server";
import { getDb } from "@/lib/db";
import { users, SEED_ADMIN_ID } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

/**
 * The session user record as used across the app. Intentionally trimmed —
 * callers don't need `clerk_user_id` or timestamps for normal request work.
 */
export interface SessionUser {
  id: string;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
  credits: number;
}

/** Parse the comma-separated ADMIN_EMAILS env var into a lowercased Set. */
function adminEmailSet(): Set<string> {
  const raw = process.env.ADMIN_EMAILS || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Resolve the current request's user, creating a `users` row on first
 * sign-in. Admin status is recomputed every request against ADMIN_EMAILS so
 * adding/removing an email there takes effect at the next request — no
 * restart or DB surgery needed.
 *
 * First-admin continuity: if the signed-in user's email is in ADMIN_EMAILS
 * and the seed-admin row (from migration 0003) still has no clerk_user_id,
 * we claim it for this user. That preserves ownership of any books uploaded
 * before Clerk was wired up — otherwise the admin would come back to an
 * empty library belonging to an orphaned UUID. Non-admin first sign-ins
 * always get a fresh row.
 */
export async function getCurrentUser(): Promise<SessionUser> {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    const err = new Error("Not authenticated");
    (err as Error & { status?: number }).status = 401;
    throw err;
  }

  const db = getDb();
  const admins = adminEmailSet();

  // Pull email/name from Clerk. currentUser() is cached per-request so the
  // multiple getCurrentUser() calls a typical handler makes stay cheap.
  const clerkUser = await currentUser();
  const primaryEmail =
    clerkUser?.emailAddresses.find(
      (e) => e.id === clerkUser.primaryEmailAddressId,
    )?.emailAddress ??
    clerkUser?.emailAddresses[0]?.emailAddress ??
    null;
  const displayName =
    [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(" ") ||
    clerkUser?.username ||
    null;
  const emailLower = primaryEmail?.toLowerCase() ?? "";
  const shouldBeAdmin = emailLower.length > 0 && admins.has(emailLower);

  // Fast path: we've seen this clerk user before.
  let row = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, clerkId))
    .get();

  if (!row) {
    // First sign-in. If this user qualifies for admin and the seed-admin
    // row is still unclaimed, hijack it so their existing library stays
    // attached. Otherwise mint a fresh row.
    const seed = await db
      .select()
      .from(users)
      .where(eq(users.id, SEED_ADMIN_ID))
      .get();

    if (shouldBeAdmin && seed && !seed.clerkUserId) {
      await db
        .update(users)
        .set({
          clerkUserId: clerkId,
          email: primaryEmail,
          displayName,
          isAdmin: 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(users.id, SEED_ADMIN_ID))
        .run();
      row = (await db
        .select()
        .from(users)
        .where(eq(users.id, SEED_ADMIN_ID))
        .get())!;
    } else {
      const id = randomUUID();
      await db
        .insert(users)
        .values({
          id,
          clerkUserId: clerkId,
          email: primaryEmail,
          displayName,
          isAdmin: shouldBeAdmin ? 1 : 0,
          credits: 0,
        })
        .run();
      row = (await db.select().from(users).where(eq(users.id, id)).get())!;
    }
  } else {
    // Existing user: keep email / displayName / admin flag fresh. We
    // intentionally re-sync admin status every request so env var changes
    // take effect without stale DB rows.
    const wantAdmin = shouldBeAdmin ? 1 : 0;
    const emailChanged = row.email !== primaryEmail;
    const nameChanged = row.displayName !== displayName;
    const adminChanged = row.isAdmin !== wantAdmin;
    if (emailChanged || nameChanged || adminChanged) {
      await db
        .update(users)
        .set({
          email: primaryEmail,
          displayName,
          isAdmin: wantAdmin,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(users.id, row.id))
        .run();
      row = (await db.select().from(users).where(eq(users.id, row.id)).get())!;
    }
  }

  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    isAdmin: row.isAdmin === 1,
    credits: row.credits,
  };
}

/**
 * Convenience wrapper: throws 403 semantics to the caller if the current
 * user isn't an admin. API routes convert the thrown error into a 403.
 */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user.isAdmin) {
    const err = new Error("Admin access required");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
  return user;
}
