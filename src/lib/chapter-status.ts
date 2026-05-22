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
        textCount: sql<number>`SUM(CASE WHEN ${paragraphs.kind} = 'text' THEN 1 ELSE 0 END)`,
        imageCount: sql<number>`SUM(CASE WHEN ${paragraphs.kind} = 'image' THEN 1 ELSE 0 END)`,
      })
      .from(paragraphs)
      .where(eq(paragraphs.chapterId, chapterId))
      .get();

    const textCount = Number(paraStats?.textCount ?? 0);
    const imageCount = Number(paraStats?.imageCount ?? 0);
    if (textCount === 0 && imageCount > 0) {
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
