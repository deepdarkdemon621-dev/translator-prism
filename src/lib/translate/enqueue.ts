import { getDb } from "@/lib/db";
import { chapters, paragraphs, translations } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";

const TARGET_LANGS: Record<string, string[]> = {
  ja: ["zh", "en"],
  zh: ["ja", "en"],
  en: ["ja", "zh"],
};

export interface EnqueueResult {
  queued: number;
  skippedDone: number;
  totalParagraphs: number;
  queuedChars: number;
}

export async function enqueueChapterTranslations(
  chapterId: string,
  sourceLang: string,
): Promise<EnqueueResult> {
  const db = getDb();

  let paras = await db
    .select()
    .from(paragraphs)
    .where(and(eq(paragraphs.chapterId, chapterId), eq(paragraphs.kind, "text")))
    .orderBy(paragraphs.seq)
    .all();

  if (paras.length === 0) {
    const chapter = await db
      .select()
      .from(chapters)
      .where(eq(chapters.id, chapterId))
      .get();
    if (!chapter) {
      return { queued: 0, skippedDone: 0, totalParagraphs: 0, queuedChars: 0 };
    }

    const cheerio = await import("cheerio");
    const $ = cheerio.load(chapter.sourceHtml, { xmlMode: true });
    const extracted: { text: string; markup: string; kind: "text" | "image" }[] = [];

    const body = $("body").get(0);
    if (body) {
      const walk = (node: import("domhandler").Element, insideParagraph: boolean): void => {
        if (node.type !== "tag") return;
        const tag = node.tagName?.toLowerCase();
        if (tag === "p") {
          const text = $(node).text().trim();
          if (text.length > 0) {
            const markup = $.html(node) || "";
            extracted.push({ text, markup, kind: "text" });
          }
          return;
        }
        // Accept both HTML <img> and SVG <image xlink:href>. For SVG we
        // synthesize an <img> tag — the original xlink:href will not have
        // been rewritten by rewriteImageSrcs (which only matches src="…"),
        // so we use the original href as-is; it's already absolute only
        // for HTML <img>. Legacy chapters with SVG covers rarely hit this
        // path (parser now emits the row up front), but keep the branch
        // so the fallback stays consistent.
        if ((tag === "img" || tag === "image") && !insideParagraph) {
          const src =
            $(node).attr("src") ||
            $(node).attr("xlink:href") ||
            $(node).attr("href");
          if (!src) return;
          const alt = ($(node).attr("alt") || "").trim();
          const markup =
            tag === "img"
              ? $.html(node) || `<img src="${src}" alt="${alt}">`
              : `<img src="${src}" alt="${alt}">`;
          extracted.push({ text: alt, markup, kind: "image" });
          return;
        }
        for (const kid of $(node).contents().toArray()) {
          walk(kid as import("domhandler").Element, insideParagraph || tag === "p");
        }
      };
      for (const kid of $(body).contents().toArray()) {
        walk(kid as import("domhandler").Element, false);
      }
    }

    if (extracted.length > 0) {
      await db.transaction(async (tx) => {
        const rows = extracted.map((e, j) => ({
          id: randomUUID(),
          chapterId,
          seq: j,
          sourceText: e.text,
          sourceMarkup: e.markup,
          kind: e.kind,
        }));
        for (let i = 0; i < rows.length; i += 500) {
          await tx.insert(paragraphs).values(rows.slice(i, i + 500));
        }
      });
    }

    paras = await db
      .select()
      .from(paragraphs)
      .where(and(eq(paragraphs.chapterId, chapterId), eq(paragraphs.kind, "text")))
      .orderBy(paragraphs.seq)
      .all();
  }

  const targetLangs = TARGET_LANGS[sourceLang] || ["zh", "en"];
  let queued = 0;
  let skippedDone = 0;
  let queuedChars = 0;

  await db.transaction(async (tx) => {
    for (const para of paras) {
      const existingForPara = await tx
        .select()
        .from(translations)
        .where(eq(translations.paragraphId, para.id))
        .all();

      for (const lang of targetLangs) {
        const existing = existingForPara.find((t) => t.lang === lang);
        if (existing && existing.status === "done") {
          skippedDone++;
          continue;
        }

        if (!existing) {
          await tx.insert(translations).values({
            id: randomUUID(),
            paragraphId: para.id,
            lang,
            status: "pending",
          });
        } else {
          await tx
            .update(translations)
            .set({
              status: "pending",
              errorMessage: null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(translations.id, existing.id));
        }
        queued++;
        queuedChars += para.sourceText.length;
      }
    }

    if (queued > 0) {
      await tx
        .update(chapters)
        .set({ status: "translating", updatedAt: new Date().toISOString() })
        .where(eq(chapters.id, chapterId));
    }
  });

  return {
    queued,
    skippedDone,
    totalParagraphs: paras.length,
    queuedChars,
  };
}

export async function estimateChapterWork(
  chapterId: string,
  sourceLang: string,
): Promise<{ queuedChars: number; queuedTranslations: number }> {
  const db = getDb();
  const paras = await db
    .select()
    .from(paragraphs)
    .where(and(eq(paragraphs.chapterId, chapterId), eq(paragraphs.kind, "text")))
    .all();

  const targetLangs = TARGET_LANGS[sourceLang] || ["zh", "en"];

  if (paras.length === 0) {
    const chapter = await db
      .select()
      .from(chapters)
      .where(eq(chapters.id, chapterId))
      .get();
    if (!chapter) return { queuedChars: 0, queuedTranslations: 0 };
    const approxChars = Math.round(chapter.sourceHtml.length * 0.6);
    return {
      queuedChars: approxChars * targetLangs.length,
      queuedTranslations: targetLangs.length,
    };
  }

  let queuedChars = 0;
  let queuedTranslations = 0;

  for (const para of paras) {
    const existingForPara = await db
      .select()
      .from(translations)
      .where(eq(translations.paragraphId, para.id))
      .all();
    for (const lang of targetLangs) {
      const existing = existingForPara.find((t) => t.lang === lang);
      if (existing && existing.status === "done") continue;
      queuedTranslations++;
      queuedChars += para.sourceText.length;
    }
  }

  return { queuedChars, queuedTranslations };
}
