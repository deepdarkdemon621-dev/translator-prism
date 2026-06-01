import { getDb } from "@/lib/db";
import { translations } from "@/lib/db/schema";
import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";

const PERMANENT_CODES = ["auth_error", "model_not_found", "quota_exhausted"];

export interface RequeueFailedOptions {
  retryLimit: number;
  batchSize: number;
}

export async function requeueEligibleFailedTranslations(
  options: RequeueFailedOptions,
): Promise<number> {
  const db = getDb();
  const now = new Date().toISOString();

  const rows = await db
    .select({ id: translations.id })
    .from(translations)
    .where(
      and(
        eq(translations.status, "failed"),
        lt(translations.retryCount, options.retryLimit),
        or(
          isNull(translations.lastErrorCode),
          notInArray(translations.lastErrorCode, PERMANENT_CODES),
        ),
      ),
    )
    .limit(options.batchSize);

  if (rows.length === 0) return 0;

  await db
    .update(translations)
    .set({
      status: "pending",
      errorMessage: null,
      retryCount: sql`${translations.retryCount} + 1`,
      updatedAt: now,
    })
    .where(inArray(translations.id, rows.map((row) => row.id)));

  return rows.length;
}
