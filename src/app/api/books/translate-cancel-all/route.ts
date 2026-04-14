import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { cancelBookTranslations } from "@/lib/translate/cancel";

/**
 * Admin-only library sweep: cancel every pending/processing translation
 * across every book the admin owns. Mirrors /api/books/translate-all in
 * scope — only admin's own uploads, to avoid surprise-cancelling someone
 * else's in-flight work.
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const db = getDb();
  const myBooks = db
    .select({ id: books.id })
    .from(books)
    .where(eq(books.userId, user.id))
    .all();

  let cancelled = 0;
  let chaptersReset = 0;
  let booksTouched = 0;
  for (const b of myBooks) {
    const res = cancelBookTranslations(b.id);
    cancelled += res.cancelled;
    chaptersReset += res.chaptersReset;
    if (res.cancelled > 0) booksTouched++;
  }

  return NextResponse.json({ cancelled, chaptersReset, booksTouched });
}
