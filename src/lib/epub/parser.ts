import JSZip from "jszip";
import * as cheerio from "cheerio";

// Narrow set of image mime types we persist. Anything else we either
// infer from the file extension or skip. Keep this list in sync with
// the content-type returned by the /api/books/:id/cover route so we
// don't set a mime we can't also serve.
function extFromMime(mime: string, href: string): string {
  const m = mime.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("svg")) return "svg";
  // Fall back to whatever is after the last dot in the href.
  const extMatch = href.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (extMatch) {
    const ext = extMatch[1];
    if (ext === "jpeg") return "jpg";
    if (["jpg", "png", "webp", "gif", "svg"].includes(ext)) return ext;
  }
  return "jpg";
}

function mimeFromExt(ext: string): string {
  switch (ext) {
    case "png": return "image/png";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "svg": return "image/svg+xml";
    default: return "image/jpeg";
  }
}

export interface ParsedParagraph {
  text: string;
  markup: string;
}

export interface ParsedChapter {
  title: string;
  sourceHtml: string;
  paragraphs: ParsedParagraph[];
}

export interface ParsedEpub {
  title: string;
  author: string;
  language: string;
  chapters: ParsedChapter[];
  /** Cover image bytes if the EPUB advertised one, otherwise undefined.
   * Caller decides where to put them — the parser stays I/O-free so it's
   * still cheap to call in unit tests. */
  cover?: { bytes: Buffer; contentType: string; ext: string };
}

export async function parseEpub(buffer: Buffer): Promise<ParsedEpub> {
  const zip = await JSZip.loadAsync(buffer);

  // 1. Read container.xml to find OPF path
  const containerXml = await zip.file("META-INF/container.xml")!.async("text");
  const $container = cheerio.load(containerXml, { xmlMode: true });
  const opfPath = $container("rootfile").attr("full-path")!;
  const opfDir = opfPath.substring(0, opfPath.lastIndexOf("/") + 1);

  // 2. Parse OPF for metadata, manifest, spine
  const opfXml = await zip.file(opfPath)!.async("text");
  const $opf = cheerio.load(opfXml, { xmlMode: true });

  const title = $opf("dc\\:title, title").first().text() || "Untitled";
  const author = $opf("dc\\:creator, creator").first().text() || "Unknown";
  const language = $opf("dc\\:language, language").first().text() || "en";

  // Build manifest map: id -> { href, mediaType, properties }. We keep
  // the extra fields around so we can identify the cover image below —
  // EPUB 3 marks it via properties="cover-image" on the manifest item,
  // while EPUB 2 uses a <meta name="cover" content="<itemId>"> tag.
  interface ManifestItem {
    href: string;
    mediaType: string;
    properties: string;
  }
  const manifest = new Map<string, ManifestItem>();
  $opf("manifest item").each((_, el) => {
    const id = $opf(el).attr("id")!;
    const href = $opf(el).attr("href")!;
    manifest.set(id, {
      href,
      mediaType: $opf(el).attr("media-type") || "",
      properties: $opf(el).attr("properties") || "",
    });
  });

  // Resolve the cover image. Prefer the EPUB 3 declaration; fall back to
  // EPUB 2 <meta name="cover" …>; last-resort: first manifest item whose
  // id or href contains "cover" and is an image. Any failure here is
  // non-fatal — a book without a cover just renders with the placeholder.
  let coverItem: ManifestItem | null = null;
  for (const item of manifest.values()) {
    if (item.properties.split(/\s+/).includes("cover-image")) {
      coverItem = item;
      break;
    }
  }
  if (!coverItem) {
    const coverMetaId = $opf('metadata meta[name="cover"]').attr("content");
    if (coverMetaId && manifest.has(coverMetaId)) {
      coverItem = manifest.get(coverMetaId)!;
    }
  }
  if (!coverItem) {
    for (const [id, item] of manifest.entries()) {
      if (
        item.mediaType.startsWith("image/") &&
        (id.toLowerCase().includes("cover") ||
          item.href.toLowerCase().includes("cover"))
      ) {
        coverItem = item;
        break;
      }
    }
  }

  let cover: ParsedEpub["cover"];
  if (coverItem) {
    const coverPath = opfDir + coverItem.href;
    const coverFile = zip.file(coverPath);
    if (coverFile) {
      const u8 = await coverFile.async("uint8array");
      const ext = extFromMime(coverItem.mediaType, coverItem.href);
      cover = {
        bytes: Buffer.from(u8),
        contentType: coverItem.mediaType || mimeFromExt(ext),
        ext,
      };
    }
  }

  // Spine order
  const spineIds: string[] = [];
  $opf("spine itemref").each((_, el) => {
    spineIds.push($opf(el).attr("idref")!);
  });

  // 3. Try to extract chapter titles from NCX/NAV
  const tocId = $opf("spine").attr("toc");
  const tocTitles = new Map<string, string>();

  if (tocId && manifest.has(tocId)) {
    const tocPath = opfDir + manifest.get(tocId)!.href;
    const tocFile = zip.file(tocPath);
    if (tocFile) {
      const tocXml = await tocFile.async("text");
      const $toc = cheerio.load(tocXml, { xmlMode: true });
      $toc("navPoint").each((_, el) => {
        const label = $toc(el).find("navLabel text").first().text().trim();
        const src = $toc(el).find("content").first().attr("src");
        if (label && src) {
          // Remove fragment (#...) from src
          const cleanSrc = src.split("#")[0];
          tocTitles.set(cleanSrc, label);
        }
      });
    }
  }

  // 4. Parse each spine item
  const chapters: ParsedChapter[] = [];
  for (let i = 0; i < spineIds.length; i++) {
    const item = manifest.get(spineIds[i]);
    if (!item) continue;
    const href = item.href;

    const filePath = opfDir + href;
    const file = zip.file(filePath);
    if (!file) continue;

    const html = await file.async("text");
    const $ch = cheerio.load(html, { xmlMode: true });

    // Extract title: prefer TOC title, fallback to first h1/h2/h3
    const tocTitle = tocTitles.get(href);
    const headingTitle = $ch("h1, h2, h3").first().text().trim();
    const chapterTitle = tocTitle || headingTitle || `Chapter ${i + 1}`;

    // Extract paragraphs from <p> tags
    const paragraphs: ParsedParagraph[] = [];
    $ch("body p").each((_, el) => {
      const $el = $ch(el);
      const text = $el.text().trim();
      if (text.length === 0) return;

      const markup = $ch.html(el) || "";
      paragraphs.push({ text, markup });
    });

    chapters.push({
      title: chapterTitle,
      sourceHtml: html,
      paragraphs,
    });
  }

  return { title, author, language, chapters, cover };
}
