import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  books,
  chapters,
  paragraphs,
  translations,
} from "@/lib/db/schema";
import { and, desc, eq, like, or } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { parseErrorCode, type LLMErrorCode } from "@/lib/llm/errors";
import { visibleBooksWhereForActor } from "@/lib/library/visibility";

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

  const visibleBookWhere = await visibleBooksWhereForActor(db, user);

  // Only look at messages with a `[blocking_code]` prefix so transient
  // failures (rate_limit, network) don't trigger the banner. We want
  // two shapes: quota_exhausted and auth_error — both are sticky and
  // require user action.
  const latestBlocking = await db
    .select({ errorMessage: translations.errorMessage })
    .from(translations)
    .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
    .innerJoin(chapters, eq(paragraphs.chapterId, chapters.id))
    .innerJoin(books, eq(chapters.bookId, books.id))
    .where(
      and(
        visibleBookWhere,
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
