import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { ensureDataDir } from "@/lib/db/init";
import { vocabulary } from "@/lib/db/schema";
import { and, asc, desc, eq, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";

type SortKey = "recent" | "oldest" | "due" | "mastery" | "alpha";

export async function GET(request: NextRequest) {
  ensureDataDir();
  const db = getDb();
  const user = await getCurrentUser();
  const { searchParams } = new URL(request.url);
  const lang = searchParams.get("lang");
  const due = searchParams.get("due") === "1";
  const sort = (searchParams.get("sort") ?? "recent") as SortKey;

  // Vocabulary is strictly per-user — showcase/public books don't share
  // wordlists. Admins still see only their own list here; there's no
  // equivalent "see everyone's cards" flow.
  const conditions: SQL[] = [eq(vocabulary.userId, user.id)];
  if (lang) conditions.push(eq(vocabulary.lang, lang));
  if (due) {
    // Entries are "due" when they have no nextReviewAt yet (never reviewed)
    // or their scheduled time has already passed.
    const nowIso = new Date().toISOString();
    const dueCondition = or(
      isNull(vocabulary.nextReviewAt),
      lte(vocabulary.nextReviewAt, nowIso),
    );
    if (dueCondition) conditions.push(dueCondition);
  }

  const whereClause =
    conditions.length === 1 ? conditions[0] : and(...conditions);

  // Sorting is applied in SQL so paginated reviews stay consistent. "due"
  // puts never-reviewed entries first (nulls sort as lowest in SQLite).
  const orderBy: SQL[] = (() => {
    switch (sort) {
      case "oldest":
        return [asc(vocabulary.createdAt)];
      case "due":
        return [
          sql`CASE WHEN ${vocabulary.nextReviewAt} IS NULL THEN 0 ELSE 1 END`,
          asc(vocabulary.nextReviewAt),
        ];
      case "mastery":
        return [asc(vocabulary.stage), desc(vocabulary.createdAt)];
      case "alpha":
        return [asc(vocabulary.word)];
      case "recent":
      default:
        return [desc(vocabulary.createdAt)];
    }
  })();

  const rows = db
    .select()
    .from(vocabulary)
    .where(whereClause)
    .orderBy(...orderBy)
    .all();

  return NextResponse.json(rows);
}

export async function POST(request: NextRequest) {
  ensureDataDir();
  const db = getDb();
  const user = await getCurrentUser();

  let body: {
    word?: string;
    lang?: string;
    reading?: string | null;
    gloss?: string;
    note?: string | null;
    sourceBookId?: string | null;
    sourceContext?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { word, lang, gloss } = body;
  if (!word || !lang || !gloss) {
    return NextResponse.json(
      { error: "`word`, `lang`, and `gloss` are required" },
      { status: 400 },
    );
  }

  // Dedup: if the same (user, word, lang) already exists, update it instead
  // of inserting a duplicate row. Dedup is scoped per-user so two users can
  // independently keep their own card for the same word.
  const existing = db
    .select()
    .from(vocabulary)
    .where(
      and(
        eq(vocabulary.userId, user.id),
        eq(vocabulary.word, word),
        eq(vocabulary.lang, lang),
      ),
    )
    .get();

  if (existing) {
    db.update(vocabulary)
      .set({
        reading: body.reading ?? existing.reading,
        gloss,
        note: body.note ?? existing.note,
        sourceBookId: body.sourceBookId ?? existing.sourceBookId,
        sourceContext: body.sourceContext ?? existing.sourceContext,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(vocabulary.id, existing.id))
      .run();
    return NextResponse.json({ id: existing.id, updated: true });
  }

  const id = randomUUID();
  db.insert(vocabulary)
    .values({
      id,
      userId: user.id,
      word,
      lang,
      reading: body.reading ?? null,
      gloss,
      note: body.note ?? null,
      sourceBookId: body.sourceBookId ?? null,
      sourceContext: body.sourceContext ?? null,
    })
    .run();

  return NextResponse.json({ id, created: true });
}
