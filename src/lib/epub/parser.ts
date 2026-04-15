import JSZip from "jszip";
import * as cheerio from "cheerio";
import type { Element } from "domhandler";

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

/** Keep [A-Za-z0-9._-]; replace anything else with underscore. Never
 * empty — an all-weird name collapses to "_". */
function sanitizeBasename(href: string): string {
  const base = href.split("/").pop() || href;
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "_";
}

/** Append -2, -3, … before the extension when the base name collides.
 * "foo.jpg" → "foo-2.jpg", "bar" (no ext) → "bar-2". */
function suffixForCollision(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}-${n}`;
  return `${name.substring(0, dot)}-${n}${name.substring(dot)}`;
}

/** Resolve a relative href (from <img src>) against a base directory, collapsing
 * "../" and "./" segments. Both inputs are EPUB-relative paths (forward slash,
 * never absolute). Result is the final path inside the zip. */
function resolveHref(baseDir: string, href: string): string {
  const parts = (baseDir + href).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      out.pop();
      continue;
    }
    out.push(p);
  }
  return out.join("/");
}

/** HTML-escape a string for use inside an attribute value. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface ParsedParagraph {
  text: string;
  markup: string;
  kind: "text" | "image";
  /** Only set for kind === "image". Trimmed. Empty string when the EPUB
   * omits alt. Stored but never translated. */
  alt?: string;
}

export interface ParsedChapter {
  title: string;
  sourceHtml: string;
  paragraphs: ParsedParagraph[];
}

export interface ParsedImage {
  /** Sanitized basename, unique across the parsed EPUB. */
  filename: string;
  bytes: Buffer;
  contentType: string;
}

export interface ParsedEpub {
  title: string;
  author: string;
  language: string;
  chapters: ParsedChapter[];
  /** Deduped set of images referenced by at least one chapter. The upload
   * route writes them to storage in one pass. */
  images: ParsedImage[];
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

  // Image accumulators — shared across all chapters for dedup.
  const imagesByKey = new Map<string, { filename: string; bytes: Buffer; contentType: string }>();
  const usedFilenames = new Set<string>();

  function claimFilename(sanitized: string): string {
    if (!usedFilenames.has(sanitized)) {
      usedFilenames.add(sanitized);
      return sanitized;
    }
    for (let n = 2; n < 10_000; n++) {
      const candidate = suffixForCollision(sanitized, n);
      if (!usedFilenames.has(candidate)) {
        usedFilenames.add(candidate);
        return candidate;
      }
    }
    throw new Error(`filename collision overflow for ${sanitized}`);
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

    const chapterDir = filePath.substring(0, filePath.lastIndexOf("/") + 1);

    const paragraphs: ParsedParagraph[] = [];

    // Walk <body> children in document order. Emit a text row for each
    // <p> that contains text. Emit an image row for each <img> that is
    // NOT nested inside a <p> (those stay embedded in the paragraph's
    // markup). Other elements (headings, divs) are descended into so
    // nested <p>/<img> inside them are still found.
    const body = $ch("body").get(0);
    if (body) {
      const walk = async (node: Element, insideParagraph: boolean): Promise<void> => {
        if (node.type !== "tag") return;
        const tag = node.tagName?.toLowerCase();
        if (tag === "p") {
          const $el = $ch(node);
          const text = $el.text().trim();
          if (text.length > 0) {
            const markup = $ch.html(node) || "";
            paragraphs.push({ text, markup, kind: "text" });
          }
          // Don't descend further; nested <img> inside <p> stays in markup.
          return;
        }
        if (tag === "img" && !insideParagraph) {
          const src = $ch(node).attr("src");
          if (src) {
            const alt = ($ch(node).attr("alt") || "").trim();
            // Resolve relative to chapter file, collapse "../" segments.
            const resolved = resolveHref(chapterDir, src);
            const manifestEntry = Array.from(manifest.values()).find(
              (m) => opfDir + m.href === resolved,
            );
            const sanitized = sanitizeBasename(src);
            const existing = imagesByKey.get(resolved);
            let filename: string;
            let contentType: string;
            if (existing) {
              filename = existing.filename;
              contentType = existing.contentType;
            } else {
              const imgFile = zip.file(resolved);
              if (!imgFile) {
                // Missing bytes: skip the image row entirely.
                return;
              }
              filename = claimFilename(sanitized);
              const u8 = await imgFile.async("uint8array");
              contentType =
                manifestEntry?.mediaType ||
                mimeFromExt(extFromMime("", src));
              imagesByKey.set(resolved, {
                filename,
                bytes: Buffer.from(u8),
                contentType,
              });
            }
            paragraphs.push({
              text: alt,
              markup: `<img src="images/${filename}" alt="${escapeAttr(alt)}">`,
              kind: "image",
              alt,
            });
          }
          return;
        }
        // Descend into other elements.
        const kids = $ch(node).contents().toArray();
        for (const kid of kids) await walk(kid as Element, insideParagraph);
      };
      for (const kid of $ch(body).contents().toArray()) {
        await walk(kid as Element, false);
      }
    }

    chapters.push({
      title: chapterTitle,
      sourceHtml: html,
      paragraphs,
    });
  }

  const images: ParsedImage[] = Array.from(imagesByKey.values()).map((v) => ({
    filename: v.filename,
    bytes: v.bytes,
    contentType: v.contentType,
  }));

  return { title, author, language, chapters, images, cover };
}
