import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { collections } from "@/lib/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";

// Keep CASE arms and IN params well inside SQLite's 999-variable limit.
const UPDATE_CHUNK = 200;

/**
 * PUT: reorder the collections grid. Body: { order: collectionId[] }.
 * Each collection's seq becomes its index in the array. Owner-only per
 * collection — ids the caller doesn't own are silently dropped, matching
 * the member-reorder route's permission model.
 */
export async function PUT(request: NextRequest) {
  const user = await getCurrentUser();
  const body = await request.json().catch(() => ({}));
  const order: string[] = Array.isArray(body.order) ? body.order : [];
  if (order.length === 0) {
    return NextResponse.json({ error: "order required" }, { status: 400 });
  }

  const db = getDb();
  const valid = new Set<string>();
  for (let i = 0; i < order.length; i += UPDATE_CHUNK) {
    const chunk = order.slice(i, i + UPDATE_CHUNK);
    const rows = await db
      .select({ id: collections.id })
      .from(collections)
      .where(and(inArray(collections.id, chunk), eq(collections.userId, user.id)))
      .all();
    for (const row of rows) valid.add(row.id);
  }

  const assignments = order
    .filter((id) => valid.has(id))
    .map((id, seq) => ({ id, seq }));
  const now = new Date().toISOString();
  for (let i = 0; i < assignments.length; i += UPDATE_CHUNK) {
    const chunk = assignments.slice(i, i + UPDATE_CHUNK);
    await db.run(sql`
      UPDATE collections SET
        seq = CASE id ${sql.join(
          chunk.map((a) => sql`WHEN ${a.id} THEN ${a.seq}`),
          sql` `,
        )} END,
        updated_at = ${now}
      WHERE id IN (${sql.join(chunk.map((a) => sql`${a.id}`), sql`, `)})`);
  }

  return NextResponse.json({ success: true, updated: assignments.length });
}
