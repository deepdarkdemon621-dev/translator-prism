import { getDb } from "@/lib/db";
import { books, chapters, paragraphs, translations } from "@/lib/db/schema";
import { textWithImageAlts } from "@/lib/epub/inline-text";
import { getUploadsStorage } from "@/lib/storage";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import type JSZipType from "jszip";

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

// Multi-row VALUES chunk for the conditional pending insert below. Three
// parameters per row keeps a chunk well inside statement param limits.
const CONDITIONAL_INSERT_CHUNK = 400;

/**
 * Insert pending translation rows only where no row for the same
 * (paragraph_id, lang) exists yet. Migration 0014's unique index
 * idx_translations_paragraph_lang enforces the invariant, so a plain
 * ON CONFLICT DO NOTHING covers the concurrent-enqueue race. The previous
 * pre-0014 NOT EXISTS guard used a UNION ALL compound SELECT, which the
 * Turso server rejects at this chunk size ("too many terms in compound
 * SELECT") even though local file: databases accept it — that server-side
 * failure aborted translate-all mid-book on every chapter large enough to
 * fill a chunk. One statement per chunk.
 */
export async function insertPendingTranslationsIfAbsent(
  executor: Pick<ReturnType<typeof getDb>, "run">,
  rows: { id: string; paragraphId: string; lang: string }[],
  now: string,
): Promise<void> {
  for (let i = 0; i < rows.length; i += CONDITIONAL_INSERT_CHUNK) {
    const chunk = rows.slice(i, i + CONDITIONAL_INSERT_CHUNK);
    const values = sql.join(
      chunk.map(
        (row) => sql`(${row.id}, ${row.paragraphId}, ${row.lang}, 'pending', ${now}, ${now})`,
      ),
      sql`, `,
    );
    await executor.run(sql`
      INSERT INTO translations (id, paragraph_id, lang, status, created_at, updated_at)
      VALUES ${values}
      ON CONFLICT (paragraph_id, lang) DO NOTHING`);
  }
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
    if (await markNonTranslatableOnlyChapterDone(chapterId)) {
      return { queued: 0, skippedDone: 0, totalParagraphs: 0, queuedChars: 0 };
    }
    paras = await lazyExtractParagraphs(chapterId);
  }

  if (paras.length === 0) {
    await markNonTranslatableOnlyChapterDone(chapterId);
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

  // Prefer the done row when a key already has duplicates (production data
  // predates the uniqueness invariant): a completed translation must never
  // be reset or replaced because a stale sibling row was read last.
  const existingByParaLang = new Map<string, (typeof existing)[number]>();
  for (const t of existing) {
    const key = `${t.paragraphId}|${t.lang}`;
    const prior = existingByParaLang.get(key);
    if (!prior || (prior.status !== "done" && t.status === "done")) {
      existingByParaLang.set(key, t);
    }
  }

  const toInsert: { id: string; paragraphId: string; lang: string }[] = [];
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
      // A live claim must retain its generation. Resetting it to pending lets
      // this same worker process claim the row again while the older request
      // is still in flight, and both requests share the same workerId.
      if (prior?.status === "processing") {
        continue;
      }
      if (prior) {
        idsToReset.push(prior.id);
      } else {
        toInsert.push({
          id: randomUUID(),
          paragraphId: para.id,
          lang,
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
    await insertPendingTranslationsIfAbsent(tx, toInsert, now);
    // All resets share the same SET clause, so one UPDATE per chunk covers
    // every prior row — no need to loop per row.
    for (let i = 0; i < idsToReset.length; i += INSERT_CHUNK) {
      const chunk = idsToReset.slice(i, i + INSERT_CHUNK);
      await tx
        .update(translations)
        .set({
          status: "pending",
          errorMessage: null,
          claimedBy: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
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

export interface BulkEnqueueResult {
  queued: number;
  chaptersQueued: number;
  skippedDone: number;
  imageOnlyMarkedDone: number;
  extractedChapters: number;
  /** Legacy zero-paragraph chapters deferred by the time budget. */
  remainingChapterIds: string[];
}

// inArray parameter chunk for chapter-id filters; stays well inside
// SQLite's default 999-variable statement limit.
const CHAPTER_ID_CHUNK = 400;

/**
 * Enqueue many chapters of one book in a handful of queries instead of a
 * per-chapter loop. The per-chapter loop in the translate-all route timed
 * out on Vercel for legacy books (each chapter could trigger EPUB zip
 * loading), leaving the tail of the book permanently un-enqueued.
 *
 * Chapters that already have extracted paragraphs take the cheap bulk path
 * (three queries per ~400 chapters). Image-only chapters are marked done.
 * Legacy chapters with no paragraphs still need per-chapter HTML
 * extraction; those run last under `timeBudgetMs` and any remainder is
 * returned in `remainingChapterIds` so the caller can continue later.
 */
export async function enqueueChaptersBulk(
  chapterIds: string[],
  sourceLang: string,
  opts: { timeBudgetMs?: number } = {},
): Promise<BulkEnqueueResult> {
  const db = getDb();
  const startedAt = Date.now();
  const timeBudgetMs = opts.timeBudgetMs ?? Number.POSITIVE_INFINITY;
  const ids = Array.from(new Set(chapterIds));

  const result: BulkEnqueueResult = {
    queued: 0,
    chaptersQueued: 0,
    skippedDone: 0,
    imageOnlyMarkedDone: 0,
    extractedChapters: 0,
    remainingChapterIds: [],
  };
  if (ids.length === 0) return result;

  // Classify every chapter with one aggregate per chunk.
  const withText: string[] = [];
  const imageOnly: string[] = [];
  const empty: string[] = [];
  const counted = new Set<string>();
  for (let i = 0; i < ids.length; i += CHAPTER_ID_CHUNK) {
    const chunk = ids.slice(i, i + CHAPTER_ID_CHUNK);
    const rows = await db
      .select({
        chapterId: paragraphs.chapterId,
        totalCount: sql<number>`COUNT(*)`,
        textCount: sql<number>`SUM(CASE WHEN ${paragraphs.kind} = 'text' THEN 1 ELSE 0 END)`,
      })
      .from(paragraphs)
      .where(inArray(paragraphs.chapterId, chunk))
      .groupBy(paragraphs.chapterId)
      .all();
    for (const row of rows) {
      counted.add(row.chapterId);
      if (Number(row.textCount) > 0) withText.push(row.chapterId);
      else if (Number(row.totalCount) > 0) imageOnly.push(row.chapterId);
    }
  }
  for (const id of ids) {
    if (!counted.has(id)) empty.push(id);
  }

  // Image-only chapters: nothing translatable, mark done in bulk.
  if (imageOnly.length > 0) {
    const now = new Date().toISOString();
    for (let i = 0; i < imageOnly.length; i += CHAPTER_ID_CHUNK) {
      await db
        .update(chapters)
        .set({ status: "done", updatedAt: now })
        .where(inArray(chapters.id, imageOnly.slice(i, i + CHAPTER_ID_CHUNK)));
    }
    result.imageOnlyMarkedDone = imageOnly.length;
  }

  // Bulk path: all text paragraphs plus their existing translations for the
  // whole chapter set, then the same prefer-done/skip-processing merge as
  // the single-chapter enqueue.
  if (withText.length > 0) {
    const targetLangs = TARGET_LANGS[sourceLang] || ["zh", "en"];
    const paras: { id: string; chapterId: string; sourceText: string }[] = [];
    const existing: {
      id: string;
      paragraphId: string;
      lang: string;
      status: string;
    }[] = [];
    for (let i = 0; i < withText.length; i += CHAPTER_ID_CHUNK) {
      const chunk = withText.slice(i, i + CHAPTER_ID_CHUNK);
      paras.push(
        ...(await db
          .select({
            id: paragraphs.id,
            chapterId: paragraphs.chapterId,
            sourceText: paragraphs.sourceText,
          })
          .from(paragraphs)
          .where(
            and(inArray(paragraphs.chapterId, chunk), eq(paragraphs.kind, "text")),
          )
          .orderBy(paragraphs.chapterId, paragraphs.seq)
          .all()),
      );
      existing.push(
        ...(await db
          .select({
            id: translations.id,
            paragraphId: translations.paragraphId,
            lang: translations.lang,
            status: translations.status,
          })
          .from(translations)
          .innerJoin(paragraphs, eq(paragraphs.id, translations.paragraphId))
          .where(
            and(inArray(paragraphs.chapterId, chunk), eq(paragraphs.kind, "text")),
          )
          .all()),
      );
    }

    const existingByParaLang = new Map<string, (typeof existing)[number]>();
    for (const t of existing) {
      const key = `${t.paragraphId}|${t.lang}`;
      const prior = existingByParaLang.get(key);
      if (!prior || (prior.status !== "done" && t.status === "done")) {
        existingByParaLang.set(key, t);
      }
    }

    const toInsert: { id: string; paragraphId: string; lang: string }[] = [];
    const idsToReset: string[] = [];
    const queuedByChapter = new Map<string, number>();
    for (const para of paras) {
      for (const lang of targetLangs) {
        const prior = existingByParaLang.get(`${para.id}|${lang}`);
        if (prior && prior.status === "done") {
          result.skippedDone++;
          continue;
        }
        // Same invariant as the single-chapter path: live claims keep their
        // generation; resetting them would double-claim under one workerId.
        if (prior?.status === "processing") {
          continue;
        }
        if (prior) {
          idsToReset.push(prior.id);
        } else {
          toInsert.push({ id: randomUUID(), paragraphId: para.id, lang });
        }
        result.queued++;
        queuedByChapter.set(
          para.chapterId,
          (queuedByChapter.get(para.chapterId) ?? 0) + 1,
        );
      }
    }

    if (result.queued > 0) {
      const now = new Date().toISOString();
      const chaptersToMark = Array.from(queuedByChapter.keys());
      await db.transaction(async (tx) => {
        await insertPendingTranslationsIfAbsent(tx, toInsert, now);
        for (let i = 0; i < idsToReset.length; i += INSERT_CHUNK) {
          await tx
            .update(translations)
            .set({
              status: "pending",
              errorMessage: null,
              claimedBy: null,
              leaseExpiresAt: null,
              updatedAt: now,
            })
            .where(inArray(translations.id, idsToReset.slice(i, i + INSERT_CHUNK)));
        }
        for (let i = 0; i < chaptersToMark.length; i += CHAPTER_ID_CHUNK) {
          await tx
            .update(chapters)
            .set({ status: "translating", updatedAt: now })
            .where(inArray(chapters.id, chaptersToMark.slice(i, i + CHAPTER_ID_CHUNK)));
        }
      });
      result.chaptersQueued += chaptersToMark.length;
    }
  }

  // Legacy chapters without extracted paragraphs: expensive per-chapter
  // path (HTML walk, possibly EPUB zip loading), bounded by the budget.
  for (const [i, chapterId] of empty.entries()) {
    if (Date.now() - startedAt >= timeBudgetMs) {
      result.remainingChapterIds = empty.slice(i);
      break;
    }
    const res = await enqueueChapterTranslations(chapterId, sourceLang);
    result.extractedChapters++;
    result.queued += res.queued;
    result.skippedDone += res.skippedDone;
    if (res.queued > 0) result.chaptersQueued++;
  }

  return result;
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
    if (await isNonTranslatableOnlyChapter(chapterId)) {
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
      totalCount: sql<number>`COUNT(*)`,
      textCount: sql<number>`SUM(CASE WHEN ${paragraphs.kind} = 'text' THEN 1 ELSE 0 END)`,
    })
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, chapterId))
    .get();

  return {
    totalCount: Number(row?.totalCount ?? 0),
    textCount: Number(row?.textCount ?? 0),
  };
}

async function isNonTranslatableOnlyChapter(chapterId: string) {
  const { totalCount, textCount } = await getParagraphKindCounts(chapterId);
  return textCount === 0 && totalCount > 0;
}

async function markNonTranslatableOnlyChapterDone(chapterId: string) {
  if (!(await isNonTranslatableOnlyChapter(chapterId))) return false;
  await getDb()
    .update(chapters)
    .set({ status: "done", updatedAt: new Date().toISOString() })
    .where(eq(chapters.id, chapterId))
    .run();
  return true;
}

type ChapterRow = typeof chapters.$inferSelect;

type LegacyImageResolver = {
  bookId: string;
  chapterDir: string;
  zip: JSZipType;
};

function escapeAttr(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function resolveHref(baseDir: string, href: string) {
  const cleanHref = href.split("#")[0]?.split("?")[0] ?? href;
  const parts = (baseDir + cleanHref).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function sanitizeImageFilename(href: string) {
  const cleaned = href
    .split("#")[0]
    ?.split("?")[0]
    ?.replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned && cleaned.length > 0 ? cleaned : "image";
}

function isAlreadyServedImageSrc(src: string) {
  return (
    src.startsWith("/api/books/") ||
    src.startsWith("data:") ||
    /^[a-z][a-z0-9+.-]*:/i.test(src)
  );
}

async function loadLegacyImageResolver(chapter: ChapterRow): Promise<LegacyImageResolver | null> {
  const book = await getDb()
    .select({ id: books.id, filePath: books.filePath })
    .from(books)
    .where(eq(books.id, chapter.bookId))
    .get();
  if (!book) return null;

  const storage = getUploadsStorage();
  const candidates = Array.from(
    new Set([
      book.filePath.replace(/^\/+/, ""),
      `${book.id}.epub`,
    ].filter(Boolean)),
  );

  let epubBytes: Buffer | null = null;
  for (const key of candidates) {
    try {
      epubBytes = await storage.get(key);
      break;
    } catch {
      // Try the next historical storage-key shape.
    }
  }
  if (!epubBytes) return null;

  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(epubBytes);
  const chapterPath = await findChapterPath(zip, chapter.sourceHtml);
  if (!chapterPath) return null;

  return {
    bookId: book.id,
    chapterDir: chapterPath.substring(0, chapterPath.lastIndexOf("/") + 1),
    zip,
  };
}

async function findChapterPath(zip: JSZipType, sourceHtml: string) {
  const normalizedSource = sourceHtml.replace(/\/api\/books\/[^"]+\/images\//g, "images/");
  const htmlPaths: string[] = [];
  for (const entryPath of Object.keys(zip.files)) {
    const entry = zip.files[entryPath];
    if (entry.dir || !/\.x?html?$/i.test(entryPath)) continue;
    htmlPaths.push(entryPath);
    const text = await entry.async("text");
    if (text === sourceHtml || text === normalizedSource) return entryPath;
  }
  return htmlPaths.length === 1 ? htmlPaths[0] : null;
}

async function resolveStoredImageSrc(src: string, resolver: LegacyImageResolver | null) {
  if (!resolver || isAlreadyServedImageSrc(src)) return src;
  const resolved = resolveHref(resolver.chapterDir, src);
  const file = resolver.zip.file(resolved);
  if (!file) return src;

  const filename = sanitizeImageFilename(resolved);
  const bytes = Buffer.from(await file.async("uint8array"));
  await getUploadsStorage().put(`${resolver.bookId}/images/${filename}`, bytes);
  return `/api/books/${resolver.bookId}/images/${filename}`;
}

function extractImageSrc(markup: string) {
  return (
    markup.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2] ??
    markup.match(/\bsrc\s*=\s*([^\s>]+)/i)?.[1] ??
    null
  );
}

function replaceImageSrc(markup: string, src: string) {
  const escaped = escapeAttr(src);
  if (/\bsrc\s*=\s*(["'])(.*?)\1/i.test(markup)) {
    return markup.replace(/\bsrc\s*=\s*(["'])(.*?)\1/i, `src="${escaped}"`);
  }
  if (/\bsrc\s*=\s*([^\s>]+)/i.test(markup)) {
    return markup.replace(/\bsrc\s*=\s*([^\s>]+)/i, `src="${escaped}"`);
  }
  return `<img src="${escaped}" alt="">`;
}

export async function ensureChapterImageSources(chapterId: string) {
  const db = getDb();
  const chapter = await db
    .select()
    .from(chapters)
    .where(eq(chapters.id, chapterId))
    .get();
  if (!chapter) return 0;

  const rows = await db
    .select()
    .from(paragraphs)
    .where(and(eq(paragraphs.chapterId, chapterId), eq(paragraphs.kind, "image")))
    .all();
  const candidates = rows
    .map((row) => ({ row, src: extractImageSrc(row.sourceMarkup) }))
    .filter((item): item is { row: typeof rows[number]; src: string } =>
      Boolean(item.src && !isAlreadyServedImageSrc(item.src)),
    );
  if (candidates.length === 0) return 0;

  const resolver = await loadLegacyImageResolver(chapter);
  let updated = 0;
  for (const { row, src } of candidates) {
    const nextSrc = await resolveStoredImageSrc(src, resolver);
    if (nextSrc === src) continue;
    await db
      .update(paragraphs)
      .set({ sourceMarkup: replaceImageSrc(row.sourceMarkup, nextSrc) })
      .where(eq(paragraphs.id, row.id))
      .run();
    updated++;
  }
  await markNonTranslatableOnlyChapterDone(chapterId);
  return updated;
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
  let resolverPromise: Promise<LegacyImageResolver | null> | null = null;
  const getResolver = () => {
    resolverPromise ??= loadLegacyImageResolver(chapter);
    return resolverPromise;
  };

  const body = $("body").get(0);
  if (body) {
    const walk = async (
      node: import("domhandler").Element,
      insideParagraph: boolean,
    ): Promise<void> => {
      if (node.type !== "tag") return;
      const tag = node.tagName?.toLowerCase();
      if (tag === "p") {
        const rawText = $(node).text().trim();
        if (rawText.length > 0) {
          // Inline gaiji image alts into the stored text; markup keeps the
          // original <img> for display. Mirrors the eager parser.
          const text = textWithImageAlts($, node).trim();
          const markup = $.html(node) || "";
          extracted.push({ text, markup, kind: "text" });
          return;
        }
        for (const kid of $(node).contents().toArray()) {
          await walk(kid as import("domhandler").Element, false);
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
        const storedSrc = await resolveStoredImageSrc(src, await getResolver());
        const markup = `<img src="${escapeAttr(storedSrc)}" alt="${escapeAttr(alt)}">`;
        extracted.push({ text: alt, markup, kind: "image" });
        return;
      }
      for (const kid of $(node).contents().toArray()) {
        await walk(kid as import("domhandler").Element, insideParagraph || tag === "p");
      }
    };
    for (const kid of $(body).contents().toArray()) {
      await walk(kid as import("domhandler").Element, false);
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

  await markNonTranslatableOnlyChapterDone(chapterId);
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
