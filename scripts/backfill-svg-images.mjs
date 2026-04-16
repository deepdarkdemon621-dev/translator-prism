// One-off backfill: re-extracts SVG <image xlink:href> references from
// already-uploaded chapters that the old parser missed. Only touches
// chapters whose paragraphs table has no image row despite the stored
// sourceHtml containing an SVG image. Does not delete or rewrite text
// rows — translations are untouched.
//
// Usage: node scripts/backfill-svg-images.mjs [bookId]
//   bookId optional; omit to scan every book.

import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";
import * as cheerio from "cheerio";
import { randomUUID } from "node:crypto";

const db = createClient({ url: "file:./data/db.sqlite" });

const EXT_MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
  avif: "image/avif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
};

function sanitizeBasename(href) {
  const base = href.split("/").pop() || href;
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "_";
}

function resolveHref(baseDir, href) {
  const parts = (baseDir + href).split("/");
  const out = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") { out.pop(); continue; }
    out.push(p);
  }
  return out.join("/");
}

const targetBookId = process.argv[2];
const bookRows = targetBookId
  ? (await db.execute({ sql: "SELECT id FROM books WHERE id = ?", args: [targetBookId] })).rows
  : (await db.execute("SELECT id FROM books")).rows;

for (const b of bookRows) {
  const bookId = b.id;
  const epubPath = resolve("./data/uploads", `${bookId}.epub`);
  let epubBytes;
  try {
    epubBytes = await readFile(epubPath);
  } catch {
    console.warn(`[${bookId}] epub not found at ${epubPath}, skipping`);
    continue;
  }
  const zip = await JSZip.loadAsync(epubBytes);

  const chaps = (await db.execute({
    sql: 'SELECT id, source_html FROM chapters WHERE book_id = ? ORDER BY "index"',
    args: [bookId],
  })).rows;

  let added = 0;
  for (const ch of chaps) {
    const html = ch.source_html;
    if (!html || !/<image\s[^>]*(xlink:href|href)/i.test(html)) continue;

    const existing = (await db.execute({
      sql: "SELECT COUNT(*) as n FROM paragraphs WHERE chapter_id = ? AND kind = 'image'",
      args: [ch.id],
    })).rows[0].n;
    if (Number(existing) > 0) continue;

    const paraCount = (await db.execute({
      sql: "SELECT COUNT(*) as n, MAX(seq) as maxSeq FROM paragraphs WHERE chapter_id = ?",
      args: [ch.id],
    })).rows[0];
    let seq = (paraCount.maxSeq === null ? -1 : Number(paraCount.maxSeq)) + 1;

    // Guess chapter file's zip path so xlink:href can be resolved. Look
    // for the first zip entry whose bytes match sourceHtml. Cheap enough
    // with ~50 entries per book.
    let chapterPath = null;
    for (const [p, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      if (!/\.x?html?$/i.test(p)) continue;
      const txt = await entry.async("text");
      if (txt === html.replace(/\/api\/books\/[^"]+\/images\//g, "images/")
        || txt === html) {
        chapterPath = p;
        break;
      }
    }
    if (!chapterPath) {
      // Best-effort: use any html entry whose basename appears anywhere.
      for (const p of Object.keys(zip.files)) {
        if (!zip.files[p].dir && /\.x?html?$/i.test(p)) { chapterPath = p; break; }
      }
    }
    if (!chapterPath) {
      console.warn(`[${bookId}/${ch.id}] cannot locate chapter in zip, skipping`);
      continue;
    }
    const chapterDir = chapterPath.substring(0, chapterPath.lastIndexOf("/") + 1);

    const $ = cheerio.load(html, { xmlMode: true });
    const images = $("image").toArray();
    const rows = [];
    for (const node of images) {
      const $n = $(node);
      const href = $n.attr("xlink:href") || $n.attr("href");
      if (!href) continue;
      const resolved = resolveHref(chapterDir, href);
      const file = zip.file(resolved);
      if (!file) { console.warn(`[${bookId}/${ch.id}] missing ${resolved}`); continue; }

      const sanitized = sanitizeBasename(href);
      const extMatch = sanitized.toLowerCase().match(/\.([a-z0-9]+)$/);
      const ext = extMatch && EXT_MIME[extMatch[1] === "jpeg" ? "jpg" : extMatch[1]]
        ? (extMatch[1] === "jpeg" ? "jpg" : extMatch[1])
        : "jpg";
      const contentType = EXT_MIME[ext] || "image/jpeg";

      const bytes = Buffer.from(await file.async("uint8array"));
      const dest = resolve("./data/uploads", bookId, "images", sanitized);
      await (await import("node:fs/promises")).mkdir(
        resolve("./data/uploads", bookId, "images"), { recursive: true }
      );
      await (await import("node:fs/promises")).writeFile(dest, bytes);

      const alt = ($n.attr("alt") || "").trim();
      rows.push({
        id: randomUUID(),
        chapterId: ch.id,
        seq: seq++,
        sourceText: alt,
        sourceMarkup: `<img src="/api/books/${bookId}/images/${sanitized}" alt="${alt.replace(/"/g, "&quot;")}">`,
        kind: "image",
      });
      console.log(`[${bookId}/${ch.id}] + image ${sanitized} (${contentType})`);
      added++;
    }
    const now = new Date().toISOString();
    for (const r of rows) {
      await db.execute({
        sql: "INSERT INTO paragraphs (id, chapter_id, seq, source_text, source_markup, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [r.id, r.chapterId, r.seq, r.sourceText, r.sourceMarkup, r.kind, now],
      });
    }
  }

  console.log(`[${bookId}] backfilled ${added} image rows`);
}

db.close();
