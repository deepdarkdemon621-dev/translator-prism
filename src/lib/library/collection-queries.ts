import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { getDb } from "@/lib/db";
import { books, chapters, collections, paragraphs, translations } from "@/lib/db/schema";
import {
  collectionMemberBooksWhere,
  collectionMemberBooksWhereForIds,
  type LibraryActor,
  visibleCollectionsWhereForActor,
} from "@/lib/library/visibility";

type LibraryDb = ReturnType<typeof getDb>;

export interface CollectionSummary {
  id: string;
  name: string;
  userId: string;
  visibility: string;
  bookCount: number;
  coverBookId: string | null;
  coverPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionBookWithProgress {
  id: string;
  title: string;
  author: string;
  sourceLang: string;
  coverPath: string | null;
  totalChapters: number;
  status: string;
  userId: string | null;
  seq: number | null;
  translatedChapters: number;
  pendingTranslations: number;
}

export async function listVisibleCollectionsWithSummaries(
  db: LibraryDb,
  actor: LibraryActor,
): Promise<CollectionSummary[]> {
  const whereClause = await visibleCollectionsWhereForActor(db, actor);
  const q = db.select().from(collections);
  const rows = await (whereClause ? q.where(whereClause) : q)
    .orderBy(desc(collections.updatedAt))
    .all();

  const fullAccessIds = rows
    .filter((collection) => actor.isAdmin || collection.userId === actor.id)
    .map((collection) => collection.id);
  const publicOnlyIds = rows
    .filter((collection) => !actor.isAdmin && collection.userId !== actor.id)
    .map((collection) => collection.id);

  const countsByCollection = new Map<string, number>();
  const coversByCollection = new Map<string, { id: string; coverPath: string | null }>();

  async function decorateCollectionGroup(
    collectionIds: string[],
    includePrivateMembers: boolean,
  ) {
    if (collectionIds.length === 0) return;

    const memberFilter = collectionMemberBooksWhereForIds(collectionIds, {
      includePrivateMembers,
    });

    const countRows = await db
      .select({
        collectionId: books.collectionId,
        count: sql<number>`COUNT(*)`,
      })
      .from(books)
      .where(memberFilter)
      .groupBy(books.collectionId)
      .all();
    for (const row of countRows) {
      if (row.collectionId) {
        countsByCollection.set(row.collectionId, Number(row.count));
      }
    }

    const coverRows = await db
      .select({
        collectionId: books.collectionId,
        id: books.id,
        coverPath: books.coverPath,
      })
      .from(books)
      .where(memberFilter)
      .orderBy(asc(books.collectionId), asc(books.collectionSeq), asc(books.createdAt))
      .all();
    for (const row of coverRows) {
      if (row.collectionId && !coversByCollection.has(row.collectionId)) {
        coversByCollection.set(row.collectionId, {
          id: row.id,
          coverPath: row.coverPath,
        });
      }
    }
  }

  await Promise.all([
    decorateCollectionGroup(fullAccessIds, true),
    decorateCollectionGroup(publicOnlyIds, false),
  ]);

  return rows.map((collection) => {
    const cover = coversByCollection.get(collection.id);
    return {
      id: collection.id,
      name: collection.name,
      userId: collection.userId,
      visibility: collection.visibility,
      bookCount: countsByCollection.get(collection.id) ?? 0,
      coverBookId: cover?.id ?? null,
      coverPath: cover?.coverPath ?? null,
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
    };
  });
}

export async function loadCollectionBooksWithProgress(
  db: LibraryDb,
  collectionId: string,
  options: { includePrivateMembers: boolean },
): Promise<CollectionBookWithProgress[]> {
  const rows = await db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      sourceLang: books.sourceLang,
      coverPath: books.coverPath,
      totalChapters: books.totalChapters,
      status: books.status,
      userId: books.userId,
      seq: books.collectionSeq,
    })
    .from(books)
    .where(collectionMemberBooksWhere(collectionId, options))
    .orderBy(asc(books.collectionSeq), asc(books.createdAt))
    .all();

  const bookIds = rows.map((book) => book.id);
  const doneByBook = new Map<string, number>();
  const pendingByBook = new Map<string, number>();

  if (bookIds.length) {
    const doneRows = await db
      .select({
        bookId: chapters.bookId,
        count: sql<number>`SUM(CASE WHEN ${chapters.status} = 'done' OR (
          NOT EXISTS (
            SELECT 1 FROM paragraphs p_text
            WHERE p_text.chapter_id = ${chapters.id} AND p_text.kind = 'text'
          )
          AND EXISTS (
            SELECT 1 FROM paragraphs p_any
            WHERE p_any.chapter_id = ${chapters.id}
          )
        ) THEN 1 ELSE 0 END)`,
      })
      .from(chapters)
      .where(inArray(chapters.bookId, bookIds))
      .groupBy(chapters.bookId)
      .all();
    for (const row of doneRows) {
      doneByBook.set(row.bookId, Number(row.count ?? 0));
    }

    const pendingRows = await db
      .select({
        bookId: chapters.bookId,
        count: sql<number>`COUNT(*)`,
      })
      .from(translations)
      .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
      .innerJoin(chapters, eq(paragraphs.chapterId, chapters.id))
      .where(
        and(
          inArray(chapters.bookId, bookIds),
          inArray(translations.status, ["pending", "processing"]),
        ),
      )
      .groupBy(chapters.bookId)
      .all();
    for (const row of pendingRows) {
      pendingByBook.set(row.bookId, Number(row.count));
    }
  }

  return rows.map((book) => ({
    ...book,
    translatedChapters: doneByBook.get(book.id) ?? 0,
    pendingTranslations: pendingByBook.get(book.id) ?? 0,
  }));
}
