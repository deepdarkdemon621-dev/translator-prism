import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { readingSessions } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { getCurrentUser } from "@/lib/auth";

/**
 * Reading heartbeat: accumulate time and characters into the caller's
 * per-day per-book row. The reader sends `day` in its own timezone so a
 * JST evening doesn't split across two UTC days. Throttled client-side to
 * about one call per minute to stay friendly to the Turso write quota.
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  let body: {
    bookId?: string | null;
    day?: string;
    durationMs?: number;
    charsRead?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const day = body.day ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return NextResponse.json({ error: "day (YYYY-MM-DD) required" }, { status: 400 });
  }
  const durationMs = Math.max(0, Math.min(10 * 60_000, Number(body.durationMs ?? 0)));
  const charsRead = Math.max(0, Math.min(500_000, Number(body.charsRead ?? 0)));
  if (durationMs === 0 && charsRead === 0) {
    return NextResponse.json({ ok: true });
  }
  const bookId = typeof body.bookId === "string" ? body.bookId : null;

  const db = getDb();
  const scope = and(
    eq(readingSessions.userId, user.id),
    eq(readingSessions.day, day),
    bookId === null
      ? sql`${readingSessions.bookId} IS NULL`
      : eq(readingSessions.bookId, bookId),
  );
  const now = new Date().toISOString();
  const existing = await db
    .select({ id: readingSessions.id })
    .from(readingSessions)
    .where(scope)
    .get();
  if (existing) {
    await db
      .update(readingSessions)
      .set({
        durationMs: sql`${readingSessions.durationMs} + ${durationMs}`,
        charsRead: sql`${readingSessions.charsRead} + ${charsRead}`,
        updatedAt: now,
      })
      .where(eq(readingSessions.id, existing.id))
      .run();
  } else {
    await db.insert(readingSessions).values({
      id: randomUUID(),
      userId: user.id,
      bookId,
      day,
      durationMs,
      charsRead,
      updatedAt: now,
    }).run();
  }

  return NextResponse.json({ ok: true });
}
