import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { vocabulary, wordStatus } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { getCurrentUser } from "@/lib/auth";

const VALID_LANGS = new Set(["ja", "zh", "en"]);
const VALID_STATUSES = new Set(["known", "ignored", "clear"]);

/**
 * GET ?lang=ja — the caller's full word-knowledge map for one language:
 * explicit marks (known/ignored) plus the lemma set implied by saved
 * vocabulary ("learning"). One round trip; the reader keeps it in memory
 * and patches it locally on every mark.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  const lang = request.nextUrl.searchParams.get("lang") ?? "ja";
  if (!VALID_LANGS.has(lang)) {
    return NextResponse.json({ error: "invalid lang" }, { status: 400 });
  }
  const db = getDb();

  const marks = await db
    .select({ lemma: wordStatus.lemma, status: wordStatus.status })
    .from(wordStatus)
    .where(and(eq(wordStatus.userId, user.id), eq(wordStatus.lang, lang)))
    .all();

  const learningRows = await db
    .select({ lemma: sql<string>`COALESCE(${vocabulary.lemma}, ${vocabulary.word})` })
    .from(vocabulary)
    .where(and(eq(vocabulary.userId, user.id), eq(vocabulary.lang, lang)))
    .all();

  const statuses: Record<string, string> = {};
  for (const m of marks) statuses[m.lemma] = m.status;

  return NextResponse.json({
    statuses,
    learning: learningRows.map((r) => r.lemma),
  });
}

/**
 * POST { lang, lemma, status: 'known' | 'ignored' | 'clear' } — upsert or
 * remove an explicit mark. 'clear' returns the lemma to unknown (or
 * learning, if a vocabulary row exists).
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  let body: { lang?: string; lemma?: string; status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const lang = body.lang ?? "";
  const lemma = (body.lemma ?? "").trim();
  const status = body.status ?? "";
  if (!VALID_LANGS.has(lang) || !lemma || !VALID_STATUSES.has(status)) {
    return NextResponse.json(
      { error: "lang, lemma, and status (known|ignored|clear) are required" },
      { status: 400 },
    );
  }

  const db = getDb();
  const scope = and(
    eq(wordStatus.userId, user.id),
    eq(wordStatus.lang, lang),
    eq(wordStatus.lemma, lemma),
  );

  if (status === "clear") {
    await db.delete(wordStatus).where(scope).run();
    return NextResponse.json({ lemma, status: null });
  }

  const now = new Date().toISOString();
  const existing = await db
    .select({ id: wordStatus.id })
    .from(wordStatus)
    .where(scope)
    .get();
  if (existing) {
    await db
      .update(wordStatus)
      .set({ status, updatedAt: now })
      .where(eq(wordStatus.id, existing.id))
      .run();
  } else {
    await db.insert(wordStatus).values({
      id: randomUUID(),
      userId: user.id,
      lang,
      lemma,
      status,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  return NextResponse.json({ lemma, status });
}

/**
 * PUT { lang, lemmas: string[], status: 'known' } — bulk mark, used by the
 * reader's "mark remaining words in this chapter as known" action.
 */
export async function PUT(request: NextRequest) {
  const user = await getCurrentUser();
  let body: { lang?: string; lemmas?: unknown; status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const lang = body.lang ?? "";
  const lemmas = Array.isArray(body.lemmas)
    ? Array.from(
        new Set(
          body.lemmas.filter((l): l is string => typeof l === "string" && l.trim() !== ""),
        ),
      )
    : [];
  const status = body.status ?? "known";
  if (!VALID_LANGS.has(lang) || lemmas.length === 0 || !["known", "ignored"].includes(status)) {
    return NextResponse.json(
      { error: "lang, lemmas[], and status (known|ignored) are required" },
      { status: 400 },
    );
  }

  const db = getDb();
  const now = new Date().toISOString();
  // Insert-if-absent per chunk; existing marks (either status) are kept —
  // bulk "mark known" must not overwrite an explicit 'ignored'.
  const CHUNK = 200;
  let added = 0;
  for (let i = 0; i < lemmas.length; i += CHUNK) {
    const chunk = lemmas.slice(i, i + CHUNK);
    const values = sql.join(
      chunk.map(
        (lemma) =>
          sql`(${randomUUID()}, ${user.id}, ${lang}, ${lemma}, ${status}, ${now}, ${now})`,
      ),
      sql`, `,
    );
    await db.run(sql`
      INSERT INTO word_status (id, user_id, lang, lemma, status, created_at, updated_at)
      VALUES ${values}
      ON CONFLICT (user_id, lang, lemma) DO NOTHING`);
    added += chunk.length;
  }

  return NextResponse.json({ requested: lemmas.length, added });
}
