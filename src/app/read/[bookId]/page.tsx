import { getDb } from "@/lib/db";
import { books, chapters, readingProgress } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { ReaderLayout } from "@/components/reader/ReaderLayout";
import { ensureDataDir } from "@/lib/db/init";

export default async function ReadPage({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = await params;
  ensureDataDir();
  const db = getDb();

  const book = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book) notFound();

  const chapterList = db
    .select({
      id: chapters.id,
      index: chapters.index,
      title: chapters.title,
      status: chapters.status,
    })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(chapters.index)
    .all();

  const progress = db
    .select()
    .from(readingProgress)
    .where(eq(readingProgress.bookId, bookId))
    .get();

  return (
    <ReaderLayout
      bookId={bookId}
      bookTitle={book.title}
      sourceLang={book.sourceLang}
      chapters={chapterList}
      initialChapterIndex={progress?.chapterIndex ?? 0}
    />
  );
}
