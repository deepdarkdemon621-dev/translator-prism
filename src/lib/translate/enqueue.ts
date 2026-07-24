import { getDb } from "@/lib/db";
import { books, chapters, paragraphs, translations } from "@/lib/db/schema";
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

// Compound-select chunk size for the conditional pending insert below.
// SQLITE_MAX_COMPOUND_SELECT defaults to 500 terms; stay under it.
const CONDITIONAL_INSERT_CHUNK = 400;

/**
 * Insert pending translation rows only where no row for the same
 * (paragraph_id, lang) exists yet. A concurrent enqueue can insert the same
 * key between a caller's existence read and its write transaction; there is
 * no unique index to lean on until gated migration 0014, so every row is
 * guarded with NOT EXISTS. One statement per chunk.
 */
export async function insertPendingTranslationsIfAbsent(
  executor: Pick<ReturnType<typeof getDb>, "run">,
  rows: { id: string; paragraphId: string; lang: string }[],
  now: string,
): Promise<void> {
  for (let i = 0; i < rows.length; i += CONDITIONAL_INSERT_CHUNK) {
    const chunk = rows.slice(i, i + CONDITIONAL_INSERT_CHUNK);
    const candidates = sql.join(
      chunk.map(
        (row) =>
          sql`SELECT ${row.id} AS id, ${row.paragraphId} AS paragraph_id, ${row.lang} AS lang`,
      ),
      sql` UNION ALL `,
    );
    await executor.run(sql`
      INSERT INTO translations (id, paragraph_id, lang, status, created_at, updated_at)
      SELECT c.id, c.paragraph_id, c.lang, 'pending', ${now}, ${now}
      FROM (${candidates}) AS c
      WHERE NOT EXISTS (
        SELECT 1 FROM translations t
        WHERE t.paragraph_id = c.paragraph_id AND t.lang = c.lang
      )`);
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
        const text = $(node).text().trim();
        if (text.length > 0) {
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
