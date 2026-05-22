import { getDb } from "@/lib/db";
import { chapters, paragraphs, translations } from "@/lib/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
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

// Bulk-insert chunk size. Turso caps a single statement at ~500 rows worth
// of parameters for our row width; matches the upload route's batch size.
const INSERT_CHUNK = 500;

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
    if (await markImageOnlyChapterDone(chapterId)) {
      return { queued: 0, skippedDone: 0, totalParagraphs: 0, queuedChars: 0 };
    }
    paras = await lazyExtractParagraphs(chapterId);
  }

  if (paras.length === 0) {
    await markImageOnlyChapterDone(chapterId);
    return { queued: 0, skippedDone: 0, totalParagraphs: 0, queuedChars: 0 };
  }

  const targetLangs = TARGET_LANGS[sourceLang] || ["zh", "en"];

  // One batched SELECT instead of N-per-paragraph. 44 chapters × ~50 paragraphs
  // = 2200 queries before this change; now 44. Keeps us well inside Vercel's
  // 300s function timeout even for big books.
  const paraIds = paras.map((p) => p.id);
  const existing = await db
    .select()
    .from(translations)
    .where(inArray(translations.paragraphId, paraIds))
    .all();

  const existingByParaLang = new Map<string, (typeof existing)[number]>();
  for (const t of existing) {
    existingByParaLang.set(`${t.paragraphId}|${t.lang}`, t);
  }

  const toInsert: (typeof translations.$inferInsert)[] = [];
  const idsToReset: string[] = [];
  let queued = 0;
  let skippedDone = 0;
  let queuedChars = 0;

  for (const para of paras) {
    for (const lang of targetLangs) {
      const prior = existingByParaLang.get(`${para.id}|${lang}`);
      if (prior && prior.status === "done") {
        skippedDone++;
        continue;
      }
      if (prior) {
        idsToReset.push(prior.id);
      } else {
        toInsert.push({
          id: randomUUID(),
          paragraphId: para.id,
          lang,
          status: "pending",
        });
      }
      queued++;
      queuedChars += para.sourceText.length;
    }
  }

  if (queued === 0) {
    return {
      queued: 0,
      skippedDone,
      totalParagraphs: paras.length,
      queuedChars: 0,
    };
  }

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
      const chunk = toInsert.slice(i, i + INSERT_CHUNK);
      await tx.insert(translations).values(chunk);
    }
    // All resets share the same SET clause, so one UPDATE per chunk covers
    // every prior row — no need to loop per row.
    for (let i = 0; i < idsToReset.length; i += INSERT_CHUNK) {
      const chunk = idsToReset.slice(i, i + INSERT_CHUNK);
      await tx
        .update(translations)
        .set({ status: "pending", errorMessage: null, updatedAt: now })
        .where(inArray(translations.id, chunk));
    }
    await tx
      .update(chapters)
      .set({ status: "translating", updatedAt: now })
      .where(eq(chapters.id, chapterId));
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
    if (await isImageOnlyChapter(chapterId)) {
      return { queuedChars: 0, queuedTranslations: 0 };
    }
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

  // Batched existence check — same pattern as enqueue above, 1 query
  // instead of N (one per paragraph).
  const paraIds = paras.map((p) => p.id);
  const existing = await db
    .select({
      paragraphId: translations.paragraphId,
      lang: translations.lang,
      status: translations.status,
    })
    .from(translations)
    .where(inArray(translations.paragraphId, paraIds))
    .all();

  const doneKeys = new Set<string>();
  for (const t of existing) {
    if (t.status === "done") doneKeys.add(`${t.paragraphId}|${t.lang}`);
  }

  let queuedChars = 0;
  let queuedTranslations = 0;
  for (const para of paras) {
    for (const lang of targetLangs) {
      if (doneKeys.has(`${para.id}|${lang}`)) continue;
      queuedTranslations++;
      queuedChars += para.sourceText.length;
    }
  }

  return { queuedChars, queuedTranslations };
}

async function getParagraphKindCounts(chapterId: string) {
  const db = getDb();
  const row = await db
    .select({
      textCount: sql<number>`SUM(CASE WHEN ${paragraphs.kind} = 'text' THEN 1 ELSE 0 END)`,
      imageCount: sql<number>`SUM(CASE WHEN ${paragraphs.kind} = 'image' THEN 1 ELSE 0 END)`,
    })
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, chapterId))
    .get();

  return {
    textCount: Number(row?.textCount ?? 0),
    imageCount: Number(row?.imageCount ?? 0),
  };
}

async function isImageOnlyChapter(chapterId: string) {
  const { textCount, imageCount } = await getParagraphKindCounts(chapterId);
  return textCount === 0 && imageCount > 0;
}

async function markImageOnlyChapterDone(chapterId: string) {
  if (!(await isImageOnlyChapter(chapterId))) return false;
  await getDb()
    .update(chapters)
    .set({ status: "done", updatedAt: new Date().toISOString() })
    .where(eq(chapters.id, chapterId))
    .run();
  return true;
}

/**
 * Fallback for chapters whose paragraphs weren't extracted at upload time
 * (legacy books). Walks the chapter's source HTML, emits <p> / <img> rows,
 * persists them, and returns the text paragraphs. Since the new upload
 * route extracts eagerly, this path is only hit for books uploaded before
 * 2026-04 — keep it working but don't bother optimizing further.
 */
export async function lazyExtractParagraphs(chapterId: string) {
  const db = getDb();
  const existingText = await selectTextParagraphs(chapterId);
  if (existingText.length > 0) return existingText;

  const existingAny = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, chapterId))
    .get();
  if (Number(existingAny?.count ?? 0) > 0) return existingText;

  const chapter = await db
    .select()
    .from(chapters)
    .where(eq(chapters.id, chapterId))
    .get();
  if (!chapter) return [];

  const cheerio = await import("cheerio");
  const $ = cheerio.load(chapter.sourceHtml, { xmlMode: true });
  const extracted: { text: string; markup: string; kind: "text" | "image" }[] = [];

  const body = $("body").get(0);
  if (body) {
    const walk = (
      node: import("domhandler").Element,
      insideParagraph: boolean,
    ): void => {
      if (node.type !== "tag") return;
      const tag = node.tagName?.toLowerCase();
      if (tag === "p") {
        const text = $(node).text().trim();
        if (text.length > 0) {
          const markup = $.html(node) || "";
          extracted.push({ text, markup, kind: "text" });
          return;
        }
        for (const kid of $(node).contents().toArray()) {
          walk(kid as import("domhandler").Element, false);
        }
        return;
      }
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
      const existing = await tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(paragraphs)
        .where(eq(paragraphs.chapterId, chapterId))
        .get();
      if (Number(existing?.count ?? 0) > 0) return;

      const rows = extracted.map((e, j) => ({
        id: `lazy:${chapterId}:${j}`,
        chapterId,
        seq: j,
        sourceText: e.text,
        sourceMarkup: e.markup,
        kind: e.kind,
      }));
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        await tx
          .insert(paragraphs)
          .values(rows.slice(i, i + INSERT_CHUNK))
          .onConflictDoNothing({ target: paragraphs.id });
      }
    });
  }

  return selectTextParagraphs(chapterId);
}

function selectTextParagraphs(chapterId: string) {
  return getDb()
    .select()
    .from(paragraphs)
    .where(and(eq(paragraphs.chapterId, chapterId), eq(paragraphs.kind, "text")))
    .orderBy(paragraphs.seq)
    .all();
}
