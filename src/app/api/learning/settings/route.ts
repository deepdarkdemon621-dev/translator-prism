import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import {
  DEFAULT_EBBINGHAUS_INTERVALS,
  parseIntervalOverride,
} from "@/lib/learning/ebbinghaus";

/**
 * Review scheduling preferences. Default is the classic Ebbinghaus fixed
 * curve; intervals can be customized and FSRS remains the adaptive opt-in.
 */
export async function GET() {
  const user = await getCurrentUser();
  const db = getDb();
  const row = await db
    .select({
      reviewAlgorithm: users.reviewAlgorithm,
      reviewIntervals: users.reviewIntervals,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .get();

  return NextResponse.json({
    algorithm: row?.reviewAlgorithm === "fsrs" ? "fsrs" : "ebbinghaus",
    intervals:
      parseIntervalOverride(row?.reviewIntervals ?? null) ??
      DEFAULT_EBBINGHAUS_INTERVALS,
    isCustomIntervals: parseIntervalOverride(row?.reviewIntervals ?? null) != null,
  });
}

export async function PUT(request: NextRequest) {
  const user = await getCurrentUser();
  let body: { algorithm?: string; intervals?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch: { reviewAlgorithm?: string | null; reviewIntervals?: string | null } = {};

  if (body.algorithm !== undefined) {
    if (body.algorithm !== "ebbinghaus" && body.algorithm !== "fsrs") {
      return NextResponse.json(
        { error: "algorithm must be 'ebbinghaus' or 'fsrs'" },
        { status: 400 },
      );
    }
    // NULL means default (ebbinghaus); store only the opt-in explicitly.
    patch.reviewAlgorithm = body.algorithm === "fsrs" ? "fsrs" : null;
  }

  if (body.intervals !== undefined) {
    if (body.intervals === null) {
      patch.reviewIntervals = null; // back to the default curve
    } else {
      const raw = JSON.stringify(body.intervals);
      if (!parseIntervalOverride(raw)) {
        return NextResponse.json(
          {
            error:
              "intervals must be 1-12 day counts between 0.5 and 365 (e.g. [1,2,4,7,15,30])",
          },
          { status: 400 },
        );
      }
      patch.reviewIntervals = raw;
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const db = getDb();
  await db
    .update(users)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(users.id, user.id))
    .run();

  return NextResponse.json({ ok: true });
}
