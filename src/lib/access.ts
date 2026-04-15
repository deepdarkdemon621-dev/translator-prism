import { getDb } from "@/lib/db";
import { books, chapters, paragraphs, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser, type SessionUser } from "@/lib/auth";

type Book = typeof books.$inferSelect;
type Chapter = typeof chapters.$inferSelect;
type Paragraph = typeof paragraphs.$inferSelect;

/**
 * Visibility rule:
 *   - Admin: everything.
 *   - Owner: always their own uploads.
 *   - Regular user: public books uploaded *by an admin* only. Public books
 *     uploaded by another regular user are NOT visible — this keeps users
 *     siloed from each other's libraries. Requires a users lookup per check.
 *
 * The stricter regular-user rule is new as of Clerk integration. Before
 * that, any public book was visible to everyone; now "public" only matters
 * when paired with an admin uploader.
 *
 * "Not accessible" collapses to 404 at the route layer so we don't leak
 * the existence of private books.
 */
async function canSeeBook(user: SessionUser, book: Book): Promise<boolean> {
  if (user.isAdmin) return true;
  if (book.userId === user.id) return true;
  if (book.visibility !== "public") return false;
  if (!book.userId) return false; // orphaned rows — not visible to strangers
  const uploader = await getDb()
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, book.userId))
    .get();
  return uploader?.isAdmin === 1;
}

/**
 * Admin or owner only. Used for destructive ops (delete book, edit chapter
 * source, etc.) — viewing a public showcase book doesn't grant write.
 */
function canModifyBook(user: SessionUser, book: Book): boolean {
  if (user.isAdmin) return true;
  return book.userId === user.id;
}

export async function loadBookForRead(
  id: string,
): Promise<{ user: SessionUser; book: Book | null }> {
  const user = await getCurrentUser();
  const book = await getDb().select().from(books).where(eq(books.id, id)).get();
  if (!book) return { user, book: null };
  if (!(await canSeeBook(user, book))) return { user, book: null };
  return { user, book };
}

export async function loadBookForWrite(
  id: string,
): Promise<
  | { user: SessionUser; book: Book; forbidden: false }
  | { user: SessionUser; book: null; forbidden: false }
  | { user: SessionUser; book: Book; forbidden: true }
> {
  const user = await getCurrentUser();
  const book = await getDb().select().from(books).where(eq(books.id, id)).get();
  if (!book) return { user, book: null, forbidden: false };
  if (!(await canSeeBook(user, book)))
    return { user, book: null, forbidden: false };
  if (!canModifyBook(user, book))
    return { user, book, forbidden: true };
  return { user, book, forbidden: false };
}

export async function loadChapterForRead(
  id: string,
): Promise<{
  user: SessionUser;
  chapter: Chapter | null;
  book: Book | null;
}> {
  const user = await getCurrentUser();
  const db = getDb();
  const chapter = await db
    .select()
    .from(chapters)
    .where(eq(chapters.id, id))
    .get();
  if (!chapter) return { user, chapter: null, book: null };
  const book = await db
    .select()
    .from(books)
    .where(eq(books.id, chapter.bookId))
    .get();
  if (!book || !(await canSeeBook(user, book)))
    return { user, chapter: null, book: null };
  return { user, chapter, book };
}

export async function loadChapterForWrite(
  id: string,
): Promise<
  | { user: SessionUser; chapter: Chapter; book: Book; forbidden: false }
  | { user: SessionUser; chapter: null; book: null; forbidden: false }
  | { user: SessionUser; chapter: Chapter; book: Book; forbidden: true }
> {
  const user = await getCurrentUser();
  const db = getDb();
  const chapter = await db
    .select()
    .from(chapters)
    .where(eq(chapters.id, id))
    .get();
  if (!chapter)
    return { user, chapter: null, book: null, forbidden: false };
  const book = await db
    .select()
    .from(books)
    .where(eq(books.id, chapter.bookId))
    .get();
  if (!book || !(await canSeeBook(user, book)))
    return { user, chapter: null, book: null, forbidden: false };
  if (!canModifyBook(user, book))
    return { user, chapter, book, forbidden: true };
  return { user, chapter, book, forbidden: false };
}

export async function loadParagraphForWrite(
  id: string,
): Promise<
  | {
      user: SessionUser;
      paragraph: Paragraph;
      chapter: Chapter;
      book: Book;
      forbidden: false;
    }
  | {
      user: SessionUser;
      paragraph: null;
      chapter: null;
      book: null;
      forbidden: false;
    }
  | {
      user: SessionUser;
      paragraph: Paragraph;
      chapter: Chapter;
      book: Book;
      forbidden: true;
    }
> {
  const user = await getCurrentUser();
  const db = getDb();
  const paragraph = await db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.id, id))
    .get();
  if (!paragraph)
    return {
      user,
      paragraph: null,
      chapter: null,
      book: null,
      forbidden: false,
    };
  const chapter = await db
    .select()
    .from(chapters)
    .where(eq(chapters.id, paragraph.chapterId))
    .get();
  if (!chapter)
    return {
      user,
      paragraph: null,
      chapter: null,
      book: null,
      forbidden: false,
    };
  const book = await db
    .select()
    .from(books)
    .where(eq(books.id, chapter.bookId))
    .get();
  if (!book || !(await canSeeBook(user, book)))
    return {
      user,
      paragraph: null,
      chapter: null,
      book: null,
      forbidden: false,
    };
  if (!canModifyBook(user, book))
    return { user, paragraph, chapter, book, forbidden: true };
  return { user, paragraph, chapter, book, forbidden: false };
}
