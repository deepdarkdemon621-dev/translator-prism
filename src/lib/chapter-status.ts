import { getDb } from "./db";
import { chapters, paragraphs, translations } from "./db/schema";
import { eq } from "drizzle-orm";

export function checkChapterDone(chapterId: string) {
  const db = getDb();
  const paras = db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, chapterId))
    .all();

  const allTranslations = paras.flatMap((p) =>
    db.select().from(translations).where(eq(translations.paragraphId, p.id)).all(),
  );

  const allDone = allTranslations.length > 0 && allTranslations.every((t) => t.status === "done");
  const anyFailed = allTranslations.some((t) => t.status === "failed");

  if (allDone) {
    db.update(chapters)
      .set({ status: "done", updatedAt: new Date().toISOString() })
      .where(eq(chapters.id, chapterId))
      .run();
  } else if (anyFailed && !allTranslations.some((t) => t.status === "pending" || t.status === "processing")) {
    db.update(chapters)
      .set({ status: "error", updatedAt: new Date().toISOString() })
      .where(eq(chapters.id, chapterId))
      .run();
  }
}
