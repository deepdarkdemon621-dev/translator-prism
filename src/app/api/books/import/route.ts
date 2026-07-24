import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { ensureDataDir } from "@/lib/db/init";
import { books, chapters, paragraphs, translations } from "@/lib/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { getCoversStorage } from "@/lib/storage";
import { dedupeImportTranslationRows } from "@/lib/translate/import-dedupe";
import { randomUUID } from "crypto";

const MAX_SIZE = 150 * 1024 * 1024; // 150MB — full novel with all translations ≈ 20-50MB

interface ExportedTranslation {
  lang: string;
  text: string;
  status: string;
  model: string | null;
  tokensUsed: number | null;
}
interface ExportedParagraph {
  seq: number;
  sourceText: string;
  sourceMarkup: string;
  translations: ExportedTranslation[];
}
interface ExportedChapter {
  index: number;
  title: string;
  sourceHtml: string;
  status: string;
  paragraphs: ExportedParagraph[];
}
interface ExportedPayload {
  formatVersion: number;
  exportedAt?: string;
  book: { title: string; author: string; sourceLang: string };
  cover?: { ext: string; base64: string } | null;
  chapters: ExportedChapter[];
}

/**
 * Inverse of /api/books/[id]/export. Admin-only: this is the "translate
 * locally, ship to the cloud" pipeline. The imported book always lands
 * as a `public` showcase so normal users in the cloud can read it for
 * free — the admin already paid (or spent local compute) for the
 * translations.
 *
 * The import does NOT trigger translation. Any chapter/paragraph with
 * incomplete translations in the payload simply lands with the same
 * status; the reader can retry individual paragraphs, or the admin can
 * use translate-all to fill gaps.
 */
export async function POST(request: NextRequest) {
  ensureDataDir();
  const user = await getCurrentUser();
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // Accept either multipart/form-data with a `file` field or a raw JSON
  // body. Multipart is how the UI sends it; raw JSON is handy for curl.
  let payload: ExportedPayload;
  const ct = request.headers.get("content-type") || "";
  try {
    if (ct.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file") as File | null;
      if (!file) {
        return NextResponse.json({ error: "No file" }, { status: 400 });
      }
      if (file.size > MAX_SIZE) {
        return NextResponse.json({ error: "File too large" }, { status: 400 });
      }
      payload = JSON.parse(await file.text());
    } else {
      payload = await request.json();
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!payload || payload.formatVersion !== 1) {
    return NextResponse.json(
      { error: "Unsupported export format" },
      { status: 400 },
    );
  }
  if (!payload.book?.title || !payload.book?.sourceLang) {
    return NextResponse.json(
      { error: "Export missing book metadata" },
      { status: 400 },
    );
  }
  if (!Array.isArray(payload.chapters)) {
    return NextResponse.json(
      { error: "Export missing chapters" },
      { status: 400 },
    );
  }

  const db = getDb();
  const bookId = randomUUID();

  // Persist cover first so we can set book.cover_path in the same insert.
  // Missing/invalid cover is non-fatal — book still imports.
  let coverPath: string | null = null;
  if (payload.cover?.base64) {
    try {
      const allowedExts = new Set(["jpg", "jpeg", "png", "webp", "gif", "svg"]);
      const ext = allowedExts.has(payload.cover.ext) ? payload.cover.ext : "jpg";
      const buffer = Buffer.from(payload.cover.base64, "base64");
      const coverName = `${bookId}.${ext}`;
      await getCoversStorage().put(coverName, buffer);
      coverPath = coverName;
    } catch (err) {
      console.warn("Import cover save failed:", err);
    }
  }

  // Build flat row arrays up-front so the whole import is a single
  // transaction with batched .values([...]) inserts. Turso bills per
  // write request — a large novel can have thousands of paragraphs plus
  // translations, so collapsing to ceil(rows/500) writes per table is
  // a big win. Imports are showcase content by definition — admin
  // curates, everyone reads. The admin can flip visibility later.
  const chapterRows: {
    id: string;
    bookId: string;
    index: number;
    title: string;
    sourceHtml: string;
    status: "pending" | "translating" | "done" | "error";
  }[] = [];
  const paragraphRows: {
    id: string;
    chapterId: string;
    seq: number;
    sourceText: string;
    sourceMarkup: string;
  }[] = [];
  const translationRows: {
    id: string;
    paragraphId: string;
    lang: string;
    text: string;
    status: "pending" | "processing" | "done" | "failed";
    model: string | null;
    tokensUsed: number | null;
  }[] = [];

  for (const ch of payload.chapters) {
    if (typeof ch.index !== "number" || typeof ch.title !== "string") continue;
    const chapterId = randomUUID();
    chapterRows.push({
      id: chapterId,
      bookId,
      index: ch.index,
      title: ch.title,
      sourceHtml: ch.sourceHtml || "",
      status: (["pending", "translating", "done", "error"].includes(ch.status)
        ? ch.status
        : "pending") as "pending" | "translating" | "done" | "error",
    });

    for (const p of ch.paragraphs ?? []) {
      if (typeof p.seq !== "number" || typeof p.sourceText !== "string") continue;
      const paragraphId = randomUUID();
      paragraphRows.push({
        id: paragraphId,
        chapterId,
        seq: p.seq,
        sourceText: p.sourceText,
        sourceMarkup: p.sourceMarkup || "",
      });

      for (const t of p.translations ?? []) {
        if (!t.lang) continue;
        translationRows.push({
          id: randomUUID(),
          paragraphId,
          lang: t.lang,
          text: t.text ?? "",
          status: (["pending", "processing", "done", "failed"].includes(t.status)
            ? t.status
            : "done") as "pending" | "processing" | "done" | "failed",
          model: t.model ?? null,
          tokensUsed: t.tokensUsed ?? null,
        });
      }
    }
  }

  // External payloads can carry more than one entry per (paragraph, lang);
  // land at most one row per key so the eventual 0014 unique index holds.
  const { rows: uniqueTranslationRows, dropped } =
    dedupeImportTranslationRows(translationRows);
  if (dropped > 0) {
    console.warn(`Import dropped ${dropped} duplicate translation row(s)`);
  }

  await db.transaction(async (tx) => {
    await tx.insert(books).values({
      id: bookId,
      title: payload.book.title,
      author: payload.book.author || "Unknown",
      sourceLang: payload.book.sourceLang.substring(0, 2).toLowerCase(),
      coverPath,
      // filePath is normally the EPUB key; imports have no original EPUB,
      // so point at a synthetic path. The delete route already tolerates
      // a missing storage object.
      filePath: `imported/${bookId}.json`,
      totalChapters: payload.chapters.length,
      status: "parsed",
      userId: user.id,
      visibility: "public",
    });

    for (let i = 0; i < chapterRows.length; i += 500) {
      await tx.insert(chapters).values(chapterRows.slice(i, i + 500));
    }
    for (let i = 0; i < paragraphRows.length; i += 500) {
      await tx.insert(paragraphs).values(paragraphRows.slice(i, i + 500));
    }
    for (let i = 0; i < uniqueTranslationRows.length; i += 500) {
      await tx.insert(translations).values(uniqueTranslationRows.slice(i, i + 500));
    }
  });

  const chapterCount = chapterRows.length;
  const paragraphCount = paragraphRows.length;
  const translationCount = uniqueTranslationRows.length;

  return NextResponse.json({
    id: bookId,
    title: payload.book.title,
    chapters: chapterCount,
    paragraphs: paragraphCount,
    translations: translationCount,
  });
}
