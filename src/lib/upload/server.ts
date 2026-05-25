import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { getCurrentUser, type SessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureDataDir } from "@/lib/db/init";
import { books, chapters, collections, paragraphs } from "@/lib/db/schema";
import { parseEpub } from "@/lib/epub/parser";
import { getCoversStorage, getUploadsStorage } from "@/lib/storage";

export const MAX_EPUB_UPLOAD_SIZE = 50 * 1024 * 1024;

export interface UploadedBookResponse {
  id: string;
  title: string;
  author: string;
  sourceLang: string;
  totalChapters: number;
}

interface CreateBookFromEpubOptions {
  buffer: Buffer;
  fileName: string;
  rawVisibility?: string | null;
  rawCollectionId?: string | null;
  user?: SessionUser;
  bookId?: string;
  existingFileKey?: string;
}

export function validateEpubUploadInput(fileName: string, size: number): string | null {
  if (!fileName.endsWith(".epub")) return "Only EPUB files are supported";
  if (size > MAX_EPUB_UPLOAD_SIZE) return "File too large (max 50MB)";
  return null;
}

export async function createBookFromEpub({
  buffer,
  fileName,
  rawVisibility,
  rawCollectionId,
  user,
  bookId = randomUUID(),
  existingFileKey,
}: CreateBookFromEpubOptions): Promise<UploadedBookResponse> {
  ensureDataDir();
  const sessionUser = user ?? await getCurrentUser();
  const validationError = validateEpubUploadInput(fileName, buffer.length);
  if (validationError) throw Object.assign(new Error(validationError), { status: 400 });

  const visibility = sessionUser.isAdmin
    ? rawVisibility === "private"
      ? "private"
      : "public"
    : "private";

  const storage = getUploadsStorage();
  const storedFileKey = existingFileKey ?? `${bookId}.epub`;
  if (!existingFileKey) {
    await storage.put(storedFileKey, buffer);
  }

  const parsed = await parseEpub(buffer);

  for (const img of parsed.images) {
    await storage.put(`${bookId}/images/${img.filename}`, img.bytes);
  }

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
  const collectionId = rawCollectionId?.trim();
  let targetCollectionId: string | null = null;
  let targetCollectionSeq: number | null = null;
  if (collectionId) {
    const col = await db
      .select({ userId: collections.userId })
      .from(collections)
      .where(eq(collections.id, collectionId))
      .get();
    if (col && col.userId === sessionUser.id) {
      targetCollectionId = collectionId;
      const maxRow = await db
        .select({ s: books.collectionSeq })
        .from(books)
        .where(eq(books.collectionId, collectionId))
        .all();
      const maxSeq = maxRow.reduce(
        (m, r) => (r.s != null && r.s > m ? r.s : m),
        -1,
      );
      targetCollectionSeq = maxSeq + 1;
    }
  }

  await db.transaction(async (tx) => {
    await tx.insert(books).values({
      id: bookId,
      title: parsed.title,
      author: parsed.author,
      sourceLang: parsed.language.substring(0, 2).toLowerCase(),
      coverPath,
      filePath: storedFileKey,
      totalChapters: parsed.chapters.length,
      status: "parsed",
      userId: sessionUser.id,
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

    const allParagraphRows: {
      id: string;
      chapterId: string;
      seq: number;
      sourceText: string;
      sourceMarkup: string;
      kind: "text" | "image";
    }[] = [];
    for (let ci = 0; ci < parsed.chapters.length; ci++) {
      const chId = chapterRows[ci]?.id;
      if (!chId) continue;
      const parsedCh = parsed.chapters[ci];
      for (let j = 0; j < parsedCh.paragraphs.length; j++) {
        const p = parsedCh.paragraphs[j];
        allParagraphRows.push({
          id: randomUUID(),
          chapterId: chId,
          seq: j,
          sourceText: p.text,
          sourceMarkup:
            p.kind === "image"
              ? rewriteImageSrcs(p.markup, bookId)
              : p.markup,
          kind: p.kind,
        });
      }
    }
    for (let i = 0; i < allParagraphRows.length; i += 500) {
      await tx.insert(paragraphs).values(allParagraphRows.slice(i, i + 500));
    }
  });

  return {
    id: bookId,
    title: parsed.title,
    author: parsed.author,
    sourceLang: parsed.language,
    totalChapters: parsed.chapters.length,
  };
}

function rewriteImageSrcs(html: string, bookId: string): string {
  return html.replace(
    /src="images\/([^"]+)"/g,
    (_m, fname) => `src="/api/books/${bookId}/images/${fname}"`,
  );
}
