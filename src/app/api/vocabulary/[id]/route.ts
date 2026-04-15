import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { vocabulary } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const user = await getCurrentUser();

  let body: {
    word?: string;
    reading?: string | null;
    gloss?: string;
    note?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Scope lookup by user so a card id from someone else's list returns 404
  // rather than letting cross-user edits through.
  const existing = await db
    .select()
    .from(vocabulary)
    .where(and(eq(vocabulary.id, id), eq(vocabulary.userId, user.id)))
    .get();
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db
    .update(vocabulary)
    .set({
      word: body.word ?? existing.word,
      reading: body.reading !== undefined ? body.reading : existing.reading,
      gloss: body.gloss ?? existing.gloss,
      note: body.note !== undefined ? body.note : existing.note,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(vocabulary.id, id))
    .run();

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const user = await getCurrentUser();
  const result = await db
    .delete(vocabulary)
    .where(and(eq(vocabulary.id, id), eq(vocabulary.userId, user.id)))
    .run();
  if (result.rowsAffected === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
