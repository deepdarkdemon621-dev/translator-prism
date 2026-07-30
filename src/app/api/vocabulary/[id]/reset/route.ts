import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { vocabulary } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";

/**
 * Reset an SRS card back to stage 0 and make it due immediately. Lets the
 * user pull a "Mastered" (or any already-advanced) word back into the review
 * queue without having to delete and re-add it. Correct/incorrect counters
 * are preserved so long-term stats stay intact.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const user = await getCurrentUser();

  const existing = await db
    .select()
    .from(vocabulary)
    .where(and(eq(vocabulary.id, id), eq(vocabulary.userId, user.id)))
    .get();
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const nowIso = new Date().toISOString();
  await db
    .update(vocabulary)
    .set({
      stage: 0,
      // Clear FSRS memory too, so the card restarts as genuinely new.
      state: "new",
      stability: 0,
      difficulty: null,
      nextReviewAt: nowIso,
      lastReviewedAt: null,
      updatedAt: nowIso,
    })
    .where(eq(vocabulary.id, id))
    .run();

  return NextResponse.json({ id, stage: 0, nextReviewAt: nowIso });
}
