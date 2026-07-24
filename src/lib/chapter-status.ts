import type { Client, InStatement } from "@libsql/client";
import { getDb } from "./db";
import { chapters, paragraphs, translations } from "./db/schema";
import { eq, sql } from "drizzle-orm";

export async function checkChapterDone(chapterId: string) {
  const db = getDb();
  const stats = await db
    .select({
      total: sql<number>`COUNT(${translations.id})`,
      notDone: sql<number>`SUM(CASE WHEN ${translations.status} != 'done' THEN 1 ELSE 0 END)`,
      failed: sql<number>`SUM(CASE WHEN ${translations.status} = 'failed' THEN 1 ELSE 0 END)`,
      active: sql<number>`SUM(CASE WHEN ${translations.status} IN ('pending', 'processing') THEN 1 ELSE 0 END)`,
    })
    .from(translations)
    .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
    .where(eq(paragraphs.chapterId, chapterId))
    .get();

  const total = Number(stats?.total ?? 0);
  const notDone = Number(stats?.notDone ?? 0);
  const failed = Number(stats?.failed ?? 0);
  const active = Number(stats?.active ?? 0);

  if (total > 0 && notDone === 0) {
    await db
      .update(chapters)
      .set({ status: "done", updatedAt: new Date().toISOString() })
      .where(eq(chapters.id, chapterId))
      .run();
  } else if (total === 0) {
    const paraStats = await db
      .select({
        totalCount: sql<number>`COUNT(*)`,
        textCount: sql<number>`SUM(CASE WHEN ${paragraphs.kind} = 'text' THEN 1 ELSE 0 END)`,
      })
      .from(paragraphs)
      .where(eq(paragraphs.chapterId, chapterId))
      .get();

    const totalCount = Number(paraStats?.totalCount ?? 0);
    const textCount = Number(paraStats?.textCount ?? 0);
    if (textCount === 0 && totalCount > 0) {
      await db
        .update(chapters)
        .set({ status: "done", updatedAt: new Date().toISOString() })
        .where(eq(chapters.id, chapterId))
        .run();
    }
  } else if (failed > 0 && active === 0) {
    await db
      .update(chapters)
      .set({ status: "error", updatedAt: new Date().toISOString() })
      .where(eq(chapters.id, chapterId))
      .run();
  }
}

/**
 * Grouped variant of checkChapterDone for the worker's batched persistence
 * path (ARCH-002): one aggregate query for the whole affected chapter set
 * plus one write batch, instead of one round trip per translation row. The
 * status rules mirror checkChapterDone exactly.
 */
export async function refreshChaptersStatus(
  client: Client,
  chapterIds: string[],
  now: Date = new Date(),
): Promise<void> {
  const unique = [...new Set(chapterIds)];
  if (unique.length === 0) return;
  const nowIso = now.toISOString();
  const placeholders = unique.map(() => "?").join(", ");

  const agg = await client.execute({
    sql: `SELECT p.chapter_id AS chapterId,
                 COUNT(t.id) AS total,
                 SUM(CASE WHEN t.status != 'done' THEN 1 ELSE 0 END) AS notDone,
                 SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed,
                 SUM(CASE WHEN t.status IN ('pending', 'processing') THEN 1 ELSE 0 END) AS active,
                 COUNT(DISTINCT p.id) AS paragraphCount,
                 COUNT(DISTINCT CASE WHEN p.kind = 'text' THEN p.id END) AS textParagraphCount
          FROM paragraphs p
          LEFT JOIN translations t ON t.paragraph_id = p.id
          WHERE p.chapter_id IN (${placeholders})
          GROUP BY p.chapter_id`,
    args: unique,
  });

  const updates: InStatement[] = [];
  for (const row of agg.rows) {
    const total = Number(row.total ?? 0);
    const notDone = Number(row.notDone ?? 0);
    const failed = Number(row.failed ?? 0);
    const active = Number(row.active ?? 0);
    const paragraphCount = Number(row.paragraphCount ?? 0);
    const textParagraphCount = Number(row.textParagraphCount ?? 0);

    let status: string | null = null;
    if (total > 0 && notDone === 0) {
      status = "done";
    } else if (total === 0 && textParagraphCount === 0 && paragraphCount > 0) {
      // Image-only chapter: nothing translatable, counts as done.
      status = "done";
    } else if (failed > 0 && active === 0) {
      status = "error";
    }
    if (!status) continue;
    updates.push({
      sql: "UPDATE chapters SET status = ?, updated_at = ? WHERE id = ?",
      args: [status, nowIso, String(row.chapterId)],
    });
  }

  if (updates.length > 0) {
    await client.batch(updates, "write");
  }
}
