import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { ensureDataDir } from "@/lib/db/init";
import { collections } from "@/lib/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { randomUUID } from "crypto";
import { listVisibleCollectionsWithSummaries } from "@/lib/library/collection-queries";

export async function GET() {
  ensureDataDir();
  const user = await getCurrentUser();
  const db = getDb();
  return NextResponse.json(await listVisibleCollectionsWithSummaries(db, user));
}

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
  await db
    .insert(collections)
    .values({ id, userId: user.id, name, visibility, createdAt: now, updatedAt: now })
    .run();

  return NextResponse.json({ id, name, visibility });
}

