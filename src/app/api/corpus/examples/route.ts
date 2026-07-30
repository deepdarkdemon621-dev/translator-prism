import { NextRequest, NextResponse } from "next/server";
import { getDb, getLibsqlClient } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { visibleBooksWhereForActor } from "@/lib/library/visibility";
import { books } from "@/lib/db/schema";

const MAX_EXAMPLES = 6;

/**
 * Real example sentences from the user's own library: paragraphs whose
 * lemma index contains the requested dictionary form. Matches conjugated
 * occurrences too, because the index stores kuromoji base forms.
 * Backed by paragraph_lemmas_fts (migration 0017 + backfill script).
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  const lemma = (request.nextUrl.searchParams.get("lemma") ?? "").trim();
  if (!lemma || lemma.length > 50) {
    return NextResponse.json({ error: "lemma required" }, { status: 400 });
  }

  // Visibility mirrors the library: own books + admin-public books.
  const db = getDb();
  const whereClause = await visibleBooksWhereForActor(db, {
    id: user.id,
    isAdmin: user.isAdmin,
  });
  const visible = await (whereClause
    ? db.select({ id: books.id }).from(books).where(whereClause)
    : db.select({ id: books.id }).from(books)
  ).all();
  const visibleIds = new Set(visible.map((b) => b.id));
  if (visibleIds.size === 0) return NextResponse.json({ examples: [] });

  // FTS5 phrase query; double-quote escaping guards MATCH syntax.
  const client = getLibsqlClient();
  const match = `"${lemma.replace(/"/g, '""')}"`;
  const rows = await client.execute({
    sql: `SELECT p.id AS paragraphId, p.source_text AS text,
                 b.id AS bookId, b.title AS bookTitle, c.title AS chapterTitle
          FROM paragraph_lemmas_fts f
          JOIN paragraph_lemmas pl ON pl.rowid = f.rowid
          JOIN paragraphs p ON p.id = pl.paragraph_id
          JOIN chapters c ON c.id = p.chapter_id
          JOIN books b ON b.id = c.book_id
          WHERE paragraph_lemmas_fts MATCH ?
          LIMIT 60`,
    args: [match],
  });

  const examples = [];
  for (const row of rows.rows) {
    if (!visibleIds.has(String(row.bookId))) continue;
    examples.push({
      paragraphId: String(row.paragraphId),
      text: String(row.text),
      bookId: String(row.bookId),
      bookTitle: String(row.bookTitle),
      chapterTitle: String(row.chapterTitle),
    });
    if (examples.length >= MAX_EXAMPLES) break;
  }

  return NextResponse.json(
    { examples, total: rows.rows.length },
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
}
