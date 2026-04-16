import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  books,
  chapters,
  paragraphs,
  translations,
  users,
} from "@/lib/db/schema";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { parseErrorCode, type LLMErrorCode } from "@/lib/llm/errors";

/**
 * Tiny status probe for the global banner. Every page polls this every
 * ~30s so the user learns their OpenAI / Claude balance ran out no matter
 * which page they're on, without having to open /progress.
 *
 * We keep the query lean — single LIMIT 1 SELECT for the most recent
 * failed row matching the [code] prefix we care about (`quota_exhausted`,
 * `auth_error`). Anything else (rate_limit, network) isn't banner-worthy
 * because it's transient.
 *
 * Scope is identical to /api/translation-progress: admin sees all;
 * regular users see own + admin-public.
 */
export async function GET() {
  const user = await getCurrentUser();
  const db = getDb();

  let bookIds: string[];
  if (user.isAdmin) {
    bookIds = (await db.select({ id: books.id }).from(books).all()).map(
      (b) => b.id,
    );
  } else {
    const adminIds = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.isAdmin, 1))
        .all()
    ).map((u) => u.id);
    const visible = adminIds.length
      ? or(
          eq(books.userId, user.id),
          and(eq(books.visibility, "public"), inArray(books.userId, adminIds)),
        )
      : eq(books.userId, user.id);
    bookIds = (
      await db.select({ id: books.id }).from(books).where(visible).all()
    ).map((b) => b.id);
  }

  if (bookIds.length === 0) {
    return NextResponse.json({
      quotaExhausted: false,
      authError: false,
      recentCode: null,
    });
  }

  // Only look at messages with a `[blocking_code]` prefix so transient
  // failures (rate_limit, network) don't trigger the banner. We want
  // two shapes: quota_exhausted and auth_error — both are sticky and
  // require user action.
  const latestBlocking = await db
    .select({ errorMessage: translations.errorMessage })
    .from(translations)
    .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
    .innerJoin(chapters, eq(paragraphs.chapterId, chapters.id))
    .where(
      and(
        inArray(chapters.bookId, bookIds),
        eq(translations.status, "failed"),
        or(
          like(translations.errorMessage, "[quota_exhausted]%"),
          like(translations.errorMessage, "[auth_error]%"),
        ),
      ),
    )
    .orderBy(desc(translations.updatedAt))
    .limit(1)
    .get();

  const recentCode: LLMErrorCode | null = latestBlocking
    ? parseErrorCode(latestBlocking.errorMessage)
    : null;

  return NextResponse.json({
    quotaExhausted: recentCode === "quota_exhausted",
    authError: recentCode === "auth_error",
    recentCode,
  });
}
