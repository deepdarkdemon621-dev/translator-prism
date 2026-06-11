import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { getDb } from "@/lib/db";
import {
  books,
  chapters,
  paragraphs,
  readingProgress,
  SEED_ADMIN_ID,
  translations,
} from "@/lib/db/schema";
import { DEFAULT_LANG_ORDER } from "@/lib/reader/language-selection";
import type {
  TerminalParagraph,
  TerminalTranslation,
} from "@/lib/reader/terminal-format";
import type { TerminalProgress } from "@/lib/reader/terminal-progress";

export type {
  TerminalParagraph,
  TerminalTranslation,
} from "@/lib/reader/terminal-format";

type ReaderDb = ReturnType<typeof getDb>;

export type TerminalBook = {
  id: string;
  title: string;
  author: string;
  sourceLang: string;
  chapters: Array<{
    id: string;
    index: number;
    title: string;
    status: string;
  }>;
};

export type TerminalBookListItem = {
  id: string;
  title: string;
  author: string;
  sourceLang: string;
  status: string;
  totalChapters: number;
};

export type TerminalChapter = {
  id: string;
  title: string;
  status: string;
  availableLangs: string[];
  paragraphs: TerminalParagraph[];
};

function orderReaderLangs(langs: Set<string>): string[] {
  return DEFAULT_LANG_ORDER.filter((lang) => langs.has(lang));
}

async function progressUserIdForBook(
  db: ReaderDb,
  bookId: string,
): Promise<string | null> {
  const book = await db
    .select({ userId: books.userId })
    .from(books)
    .where(eq(books.id, bookId))
    .get();
  if (!book) return null;
  return book.userId ?? SEED_ADMIN_ID;
}

export async function listTerminalBooks(
  db: ReaderDb,
  limit = 50,
): Promise<TerminalBookListItem[]> {
  return db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      sourceLang: books.sourceLang,
      status: books.status,
      totalChapters: books.totalChapters,
    })
    .from(books)
    .orderBy(desc(books.createdAt), asc(books.title))
    .limit(limit)
    .all();
}

export async function loadTerminalBook(
  db: ReaderDb,
  bookId: string,
): Promise<TerminalBook | null> {
  const book = await db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      sourceLang: books.sourceLang,
    })
    .from(books)
    .where(eq(books.id, bookId))
    .get();

  if (!book) return null;

  const chapterRows = await db
    .select({
      id: chapters.id,
      index: chapters.index,
      title: chapters.title,
      status: chapters.status,
    })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.index))
    .all();

  return {
    ...book,
    chapters: chapterRows,
  };
}

export async function loadTerminalChapter(
  db: ReaderDb,
  chapterId: string,
  sourceLang: string,
): Promise<TerminalChapter | null> {
  const chapter = await db
    .select({
      id: chapters.id,
      title: chapters.title,
      status: chapters.status,
    })
    .from(chapters)
    .where(eq(chapters.id, chapterId))
    .get();

  if (!chapter) return null;

  const paragraphRows = await db
    .select({
      id: paragraphs.id,
      seq: paragraphs.seq,
      sourceText: paragraphs.sourceText,
      kind: paragraphs.kind,
    })
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, chapterId))
    .orderBy(asc(paragraphs.seq))
    .all();

  const paragraphIds = paragraphRows.map((paragraph) => paragraph.id);
  const translationRows = paragraphIds.length > 0
    ? await db
        .select({
          paragraphId: translations.paragraphId,
          lang: translations.lang,
          text: translations.text,
          status: translations.status,
          errorMessage: translations.errorMessage,
        })
        .from(translations)
        .where(inArray(translations.paragraphId, paragraphIds))
        .all()
    : [];

  const availableLangs = new Set<string>();
  const paragraphOrder = new Map(
    paragraphRows.map((paragraph, index) => [paragraph.id, index]),
  );
  const translationsByParagraph = new Map<string, Record<string, TerminalTranslation>>();

  const sortedTranslationRows = [...translationRows].sort((left, right) => {
    const leftOrder = paragraphOrder.get(left.paragraphId) ?? 0;
    const rightOrder = paragraphOrder.get(right.paragraphId) ?? 0;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.lang.localeCompare(right.lang);
  });

  for (const translation of sortedTranslationRows) {
    availableLangs.add(translation.lang);
    const bucket = translationsByParagraph.get(translation.paragraphId) ?? {};
    bucket[translation.lang] = {
      text: translation.text,
      status: translation.status,
      errorMessage: translation.errorMessage,
    };
    translationsByParagraph.set(translation.paragraphId, bucket);
  }

  return {
    ...chapter,
    availableLangs: orderReaderLangs(availableLangs),
    paragraphs: paragraphRows.map((paragraph) => ({
      seq: paragraph.seq,
      kind: paragraph.kind,
      sourceLang,
      sourceText: paragraph.kind === "image" ? "[image]" : paragraph.sourceText,
      translations: translationsByParagraph.get(paragraph.id) ?? {},
    })),
  };
}

export async function loadTerminalDbProgress(
  db: ReaderDb,
  bookId: string,
): Promise<TerminalProgress | null> {
  const userId = await progressUserIdForBook(db, bookId);
  if (!userId) return null;

  const row = await db
    .select({
      chapterIndex: readingProgress.chapterIndex,
      scrollPosition: readingProgress.scrollPosition,
    })
    .from(readingProgress)
    .where(
      and(
        eq(readingProgress.bookId, bookId),
        eq(readingProgress.userId, userId),
      ),
    )
    .get();

  if (!row) return null;
  return {
    chapterIndex: row.chapterIndex,
    page: Math.max(0, Math.trunc(row.scrollPosition)),
    langs: "auto",
  };
}

export async function saveTerminalDbProgress(
  db: ReaderDb,
  bookId: string,
  progress: TerminalProgress,
): Promise<void> {
  const userId = await progressUserIdForBook(db, bookId);
  if (!userId) return;

  const existing = await db
    .select({ id: readingProgress.id })
    .from(readingProgress)
    .where(
      and(
        eq(readingProgress.bookId, bookId),
        eq(readingProgress.userId, userId),
      ),
    )
    .get();

  const updatedAt = new Date().toISOString();
  if (existing) {
    await db
      .update(readingProgress)
      .set({
        chapterIndex: progress.chapterIndex,
        scrollPosition: progress.page,
        updatedAt,
      })
      .where(eq(readingProgress.id, existing.id))
      .run();
    return;
  }

  await db
    .insert(readingProgress)
    .values({
      id: randomUUID(),
      bookId,
      userId,
      chapterIndex: progress.chapterIndex,
      scrollPosition: progress.page,
      updatedAt,
    })
    .run();
}
