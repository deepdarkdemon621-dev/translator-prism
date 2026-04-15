import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { ensureDataDir } from "@/lib/db/init";
import { books, chapters, collections, paragraphs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { parseEpub } from "@/lib/epub/parser";
import { getCurrentUser } from "@/lib/auth";
import { getUploadsStorage, getCoversStorage } from "@/lib/storage";
import { randomUUID } from "crypto";

const MAX_SIZE = 50 * 1024 * 1024; // 50MB

/** Replace every `src="images/{filename}"` (the parser's relative form) with
 * the absolute API route. Operates on raw HTML/markup strings; no parsing
 * required because the parser only emits this exact pattern for image rows. */
function rewriteImageSrcs(html: string, bookId: string): string {
  return html.replace(
    /src="images\/([^"]+)"/g,
    (_m, fname) => `src="/api/books/${bookId}/images/${fname}"`,
  );
}

export async function POST(request: NextRequest) {
  ensureDataDir();
  const user = await getCurrentUser();
  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  // Admin-only: visibility toggle. Regular users always upload as 'private'
  // regardless of what they send, so we don't trust the form field unless
  // the caller is admin. Admin default when field is missing = 'public'.
  const rawVisibility = (formData.get("visibility") as string | null)?.trim();
  const visibility = user.isAdmin
    ? rawVisibility === "private"
      ? "private"
      : "public"
    : "private";

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "File too large (max 50MB)" }, { status: 400 });
  }

  if (!file.name.endsWith(".epub")) {
    return NextResponse.json({ error: "Only EPUB files are supported" }, { status: 400 });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());

    // Save file via the storage abstraction so we have one knob to turn
    // when we swap local disk for R2/S3.
    const bookId = randomUUID();
    const fileName = `${bookId}.epub`;
    await getUploadsStorage().put(fileName, buffer);

    // Parse EPUB
    const parsed = await parseEpub(buffer);

    // Persist images under {bookId}/images/{filename}. Writes happen before
    // the DB transaction so a partial-write failure aborts the upload with
    // no orphaned rows. Storage writes that *do* succeed before a later
    // failure are acceptable garbage (no GC job today — next upload for
    // the same file would just overwrite).
    for (const img of parsed.images) {
      await getUploadsStorage().put(
        `${bookId}/images/${img.filename}`,
        img.bytes,
      );
    }

    // Persist the cover image (if any) alongside the EPUB itself. We
    // store it in a separate bucket so the public cover URL doesn't leak
    // the private EPUB path. Non-fatal on failure — a missing cover just
    // means the card renders with the placeholder.
    let coverPath: string | null = null;
    if (parsed.cover) {
      try {
        const coverName = `${bookId}.${parsed.cover.ext}`;
        await getCoversStorage().put(coverName, parsed.cover.bytes);
        coverPath = coverName;
      } catch (err) {
        console.warn("Failed to save cover image:", err);
      }
    }

    const db = getDb();

    // Optional destination collection. Silently ignored if it doesn't
    // resolve to a collection owned by the current user — the upload must
    // succeed regardless of folder placement. The book just lands top-level
    // in that case and the user can move it manually.
    const rawCollectionId = (formData.get("collectionId") as string | null)?.trim();
    let targetCollectionId: string | null = null;
    let targetCollectionSeq: number | null = null;
    if (rawCollectionId) {
      const col = await db
        .select({ userId: collections.userId })
        .from(collections)
        .where(eq(collections.id, rawCollectionId))
        .get();
      if (col && col.userId === user.id) {
        targetCollectionId = rawCollectionId;
        const maxRow = await db
          .select({ s: books.collectionSeq })
          .from(books)
          .where(eq(books.collectionId, rawCollectionId))
          .all();
        const maxSeq = maxRow.reduce(
          (m, r) => (r.s != null && r.s > m ? r.s : m),
          -1,
        );
        targetCollectionSeq = maxSeq + 1;
      }
    }

    // Insert book + chapters + first-chapter paragraphs in a single
    // transaction with batched .values([...]) arrays. Turso bills per
    // write request, so collapsing N+1 roundtrips into ceil(N/500) is a
    // big deal for large EPUBs. Visibility comes from the form: admin
    // can pick public/private (default public); regular users are
    // always private.
    await db.transaction(async (tx) => {
      await tx.insert(books).values({
        id: bookId,
        title: parsed.title,
        author: parsed.author,
        sourceLang: parsed.language.substring(0, 2).toLowerCase(),
        coverPath,
        filePath: fileName,
        totalChapters: parsed.chapters.length,
        status: "parsed",
        userId: user.id,
        visibility,
        collectionId: targetCollectionId,
        collectionSeq: targetCollectionSeq,
      });

      const chapterRows = parsed.chapters.map((ch, i) => ({
        id: randomUUID(),
        bookId,
        index: i,
        title: ch.title,
        sourceHtml: rewriteImageSrcs(ch.sourceHtml, bookId),
        status: "pending" as const,
      }));
      if (chapterRows.length > 0) {
        for (let i = 0; i < chapterRows.length; i += 500) {
          await tx.insert(chapters).values(chapterRows.slice(i, i + 500));
        }
      }

      const firstChapterId = chapterRows[0]?.id;
      if (firstChapterId && parsed.chapters[0]) {
        const paragraphRows = parsed.chapters[0].paragraphs.map((p, j) => ({
          id: randomUUID(),
          chapterId: firstChapterId,
          seq: j,
          sourceText: p.text,
          sourceMarkup:
            p.kind === "image"
              ? rewriteImageSrcs(p.markup, bookId)
              : p.markup,
          kind: p.kind,
        }));
        for (let i = 0; i < paragraphRows.length; i += 500) {
          await tx.insert(paragraphs).values(paragraphRows.slice(i, i + 500));
        }
      }
    });

    return NextResponse.json({
      id: bookId,
      title: parsed.title,
      author: parsed.author,
      sourceLang: parsed.language,
      totalChapters: parsed.chapters.length,
    });
  } catch (err) {
    console.error("Upload error:", err);
    return NextResponse.json(
      { error: "Failed to parse EPUB" },
      { status: 500 },
    );
  }
}
