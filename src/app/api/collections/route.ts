import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { ensureDataDir } from "@/lib/db/init";
import { books, collections, users } from "@/lib/db/schema";
import { asc, desc, eq, and, inArray, or } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { randomUUID } from "crypto";

export async function GET() {
  ensureDataDir();
  const user = await getCurrentUser();
  const db = getDb();

  // Admin backdoor: see all collections across users. Regular users see
  // their own private collections plus admin-owned public collections,
  // mirroring the books visibility rule.
  let whereClause;
  if (user.isAdmin) {
    whereClause = undefined;
  } else {
    const adminIds = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, 1))
      .all()
      .map((u) => u.id);
    const adminPublic = adminIds.length
      ? and(eq(collections.visibility, "public"), inArray(collections.userId, adminIds))
      : undefined;
    whereClause = adminPublic
      ? or(eq(collections.userId, user.id), adminPublic)
      : eq(collections.userId, user.id);
  }

  const q = db.select().from(collections);
  const rows = (whereClause ? q.where(whereClause) : q)
    .orderBy(desc(collections.updatedAt))
    .all();

  const decorated = rows.map((c) => {
    // Apply the same visibility filter to cover AND count so the card
    // only reflects books the viewer can actually open. Owner/admin see
    // everything; other viewers see public-visibility members.
    const isOwnerOrAdmin = user.isAdmin || c.userId === user.id;
    const memberFilter = isOwnerOrAdmin
      ? eq(books.collectionId, c.id)
      : and(eq(books.collectionId, c.id), eq(books.visibility, "public"));

    const coverBook = db
      .select({ id: books.id, coverPath: books.coverPath })
      .from(books)
      .where(memberFilter!)
      .orderBy(asc(books.collectionSeq), asc(books.createdAt))
      .limit(1)
      .all();

    const countRows = db
      .select({ id: books.id })
      .from(books)
      .where(memberFilter!)
      .all();
    const countVisible = countRows.length;

    const cover = coverBook[0];
    return {
      id: c.id,
      name: c.name,
      userId: c.userId,
      visibility: c.visibility,
      bookCount: countVisible,
      coverBookId: cover?.id ?? null,
      coverPath: cover?.coverPath ?? null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  });

  return NextResponse.json(decorated);
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
  db.insert(collections)
    .values({ id, userId: user.id, name, visibility, createdAt: now, updatedAt: now })
    .run();

  return NextResponse.json({ id, name, visibility });
}

