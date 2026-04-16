# EPUB Image Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render inline EPUB `<img>` elements as image rows in the trilingual reader so image-heavy chapters stop showing "No paragraphs".

**Architecture:** Add a `paragraphs.kind` column (`"text" | "image"`). The parser walks `<body>` in document order and emits a row per `<p>` or `<img>`. Image bytes are written to `{bookId}/images/{filename}` in uploads storage; a new authz-gated route streams them. Translation is filtered to `kind = 'text'`; reader and exporter branch on kind.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM over libsql, Cheerio for HTML walking, JSZip for archive reads, storage abstraction (`getUploadsStorage`), archiver for export zips.

**Spec:** `docs/superpowers/specs/2026-04-15-epub-image-support-design.md`

---

## File Structure

**New files:**
- `drizzle/0007_paragraph_kind.sql` — migration adding `kind` column
- `drizzle/meta/0007_snapshot.json` — drizzle snapshot (generated)
- `src/lib/epub/__tests__/parser.test.ts` — parser unit tests (new test file; vitest)
- `src/app/api/books/[id]/images/[filename]/route.ts` — image GET

**Modified:**
- `src/lib/db/schema.ts` — add `kind` column to `paragraphs`
- `src/lib/epub/parser.ts` — walker, `ParsedImage`, `kind`, filename sanitization
- `src/app/api/books/upload/route.ts` — persist images, rewrite src, insert kind
- `src/lib/translate/enqueue.ts` — lazy extractor walker + kind filter in both enqueue and estimator
- `src/components/reader/ColumnView.tsx` — render image branch
- `src/lib/export/exporter.ts` — HTML zip image branch + image files in archive + JSON `kind`

**Testing commands:**
- TypeScript: `npx tsc --noEmit`
- Lint: `npx next lint`
- Unit tests: `npx vitest run src/lib/epub/__tests__/parser.test.ts`
- Dev server smoke: `pnpm dev` (port 4000), upload an EPUB with images

---

## Task 1: Schema migration and schema.ts type

**Files:**
- Create: `drizzle/0007_paragraph_kind.sql`
- Create: `drizzle/meta/0007_snapshot.json` (via `npx drizzle-kit generate`)
- Modify: `src/lib/db/schema.ts:59-66`

**Context:** `paragraphs` today holds text-only rows. Adding `kind TEXT NOT NULL DEFAULT 'text'` keeps every existing insert path (no callers pass `kind`) working unchanged. The default also means the column can be added without a data backfill.

- [ ] **Step 1: Write the migration SQL**

Create `drizzle/0007_paragraph_kind.sql`:

```sql
ALTER TABLE `paragraphs` ADD `kind` text DEFAULT 'text' NOT NULL;
```

- [ ] **Step 2: Add the column to the Drizzle schema**

In `src/lib/db/schema.ts`, update the `paragraphs` table (lines 59–66) to add `kind`:

```ts
export const paragraphs = sqliteTable("paragraphs", {
  id: text("id").primaryKey(),
  chapterId: text("chapter_id").notNull().references(() => chapters.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  sourceText: text("source_text").notNull(),
  sourceMarkup: text("source_markup").notNull(),
  // "text" for <p> rows, "image" for <img> rows. Translation pipeline
  // filters to kind = 'text'; reader + exporter render both in seq order.
  kind: text("kind", { enum: ["text", "image"] }).notNull().default("text"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});
```

- [ ] **Step 3: Generate the drizzle snapshot**

Run: `npx drizzle-kit generate`

Expected: a new `drizzle/meta/0007_snapshot.json` file appears and `_journal.json` is updated with the `0007` entry. Do **not** let drizzle-kit write a second SQL file — if it does (because the SQL you wrote in Step 1 doesn't match its expectation), delete the generated SQL and keep yours, but keep the generated snapshot + journal updates.

- [ ] **Step 4: Verify types and migrate**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

Run the migrator so local dev state moves forward: delete the local sqlite file first if it has stale schema, then `pnpm dev` will apply migrations on boot (or run whatever migration entrypoint the repo uses — check `src/lib/db/init.ts`).

- [ ] **Step 5: Commit**

```bash
git add drizzle/0007_paragraph_kind.sql drizzle/meta/ src/lib/db/schema.ts
git commit -m "feat: add paragraphs.kind column for image rows"
```

---

## Task 2: Parser emits image rows

**Files:**
- Modify: `src/lib/epub/parser.ts`

**Context:** The parser currently builds paragraphs via `$ch("body p").each(...)` at lines 186–195. We need to walk `<body>` in document order and emit a row for each direct text paragraph (`<p>`) **and** each `<img>`. Images inside a `<p>` are NOT emitted separately — they stay in the paragraph's markup. `ParsedEpub` gains a top-level `images: ParsedImage[]`; the caller (upload route) writes those bytes to storage once.

Filename rules per spec §1:
- Basename only; strip directory components.
- Keep `[A-Za-z0-9._-]`; replace anything else with `_`.
- On collision (distinct hrefs sanitize to same name), append `-2`, `-3` before the extension.

Dedup rule: same resolved `opfDir + href` across chapters → one `ParsedImage` entry; both paragraphs reference the same filename.

- [ ] **Step 1: Extend the type exports**

Update the interface block at `src/lib/epub/parser.ts:35-55`:

```ts
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
  cover?: { bytes: Buffer; contentType: string; ext: string };
}
```

- [ ] **Step 2: Add filename helpers at the top of the file**

Insert below the existing `mimeFromExt` helper (around line 34):

```ts
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
```

- [ ] **Step 3: Replace the chapter-loop body with a walker**

Inside the `for (let i = 0; i < spineIds.length; i++)` block starting at line 169, replace the paragraph-extraction section (lines 187–195) with a tree walker that emits text and image rows in DOM order.

Before the outer `const chapters: ParsedChapter[] = [];` (around line 167), declare the image accumulators:

```ts
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
```

Then replace the paragraph extraction block (old lines 187–195) with this walker. `chapterDir` resolves `<img src>` relative to the chapter XHTML file's directory, not the OPF directory — an EPUB chapter at `OEBPS/text/ch1.xhtml` referencing `../images/foo.jpg` must resolve to `OEBPS/images/foo.jpg`.

```ts
    const chapterDir = filePath.substring(0, filePath.lastIndexOf("/") + 1);

    const paragraphs: ParsedParagraph[] = [];

    // Walk <body> children in document order. Emit a text row for each
    // <p> that contains text. Emit an image row for each <img> that is
    // NOT nested inside a <p> (those stay embedded in the paragraph's
    // markup). Other elements (headings, divs) are descended into so
    // nested <p>/<img> inside them are still found.
    const body = $ch("body").get(0);
    if (body) {
      const walk = (node: cheerio.Element, insideParagraph: boolean) => {
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
              filename = claimFilename(sanitized);
              const file = zip.file(resolved);
              if (!file) {
                // Missing bytes: skip the image row entirely. Spec §"Error
                // handling" allows this.
                return;
              }
              const u8 = await file.async("uint8array");
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
        // Descend.
        const kids = $ch(node).contents().toArray();
        const within = insideParagraph || tag === "p";
        for (const kid of kids) walk(kid as cheerio.Element, within);
      };
      for (const kid of $ch(body).contents().toArray()) {
        walk(kid as cheerio.Element, false);
      }
    }
```

Because the walker is `async` (it awaits `file.async("uint8array")`), lift it out of a synchronous closure. Replace `const walk = (node, insideParagraph) => {` with `const walk = async (node, insideParagraph) => {` and await each recursive call and each top-level invocation:

```ts
      const walk = async (node: cheerio.Element, insideParagraph: boolean): Promise<void> => {
        // …body above, but change the recursive call at the end to:
        for (const kid of kids) await walk(kid as cheerio.Element, within);
      };
      for (const kid of $ch(body).contents().toArray()) {
        await walk(kid as cheerio.Element, false);
      }
```

- [ ] **Step 4: Add two small helpers**

Place next to `sanitizeBasename`:

```ts
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
```

- [ ] **Step 5: Populate the returned `images` array**

At the end of the outer loop, after all chapters are pushed, and before the `return { title, author, … }` statement, build the images array from the map:

```ts
  const images: ParsedImage[] = Array.from(imagesByKey.values()).map((v) => ({
    filename: v.filename,
    bytes: v.bytes,
    contentType: v.contentType,
  }));

  return { title, author, language, chapters, images, cover };
```

- [ ] **Step 6: Verify types**

Run: `npx tsc --noEmit`
Expected: PASS. If cheerio's `Element` type import isn't available, add `import type { Element } from "domhandler";` (cheerio 1.x re-exports DOM types from domhandler).

- [ ] **Step 7: Commit**

```bash
git add src/lib/epub/parser.ts
git commit -m "feat(parser): emit image rows alongside text paragraphs"
```

---

## Task 3: Parser unit tests

**Files:**
- Create: `src/lib/epub/__tests__/parser.test.ts`

**Context:** No existing parser tests today. Vitest is already listed in `package.json` (check `devDependencies` for `vitest`; if absent, this task adds it — see Step 1). Tests build minimal EPUBs in-memory using JSZip so no fixture files are needed.

- [ ] **Step 1: Check test runner presence**

Run: `npx vitest --version`

If vitest isn't installed, install it as a dev dep:
```bash
pnpm add -D vitest
```
and add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 2: Write the test file**

Create `src/lib/epub/__tests__/parser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { parseEpub } from "../parser";

/** Build an in-memory EPUB zip with the given chapter HTMLs and image files.
 * Chapter files live at OEBPS/text/ch{N}.xhtml, images at OEBPS/images/. */
async function buildEpub(opts: {
  chapters: string[];
  imageFiles?: Record<string, Buffer>;
}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`,
  );

  const imageManifest = Object.keys(opts.imageFiles || {})
    .map(
      (path, i) =>
        `<item id="img${i}" href="${path}" media-type="image/jpeg"/>`,
    )
    .join("\n");

  const chapterManifest = opts.chapters
    .map(
      (_, i) =>
        `<item id="ch${i}" href="text/ch${i}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join("\n");
  const spine = opts.chapters
    .map((_, i) => `<itemref idref="ch${i}"/>`)
    .join("\n");

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test</dc:title><dc:creator>Author</dc:creator><dc:language>en</dc:language>
    </metadata>
    <manifest>${chapterManifest}${imageManifest}</manifest>
    <spine>${spine}</spine></package>`,
  );

  for (let i = 0; i < opts.chapters.length; i++) {
    zip.file(
      `OEBPS/text/ch${i}.xhtml`,
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>${opts.chapters[i]}</body></html>`,
    );
  }
  for (const [path, bytes] of Object.entries(opts.imageFiles || {})) {
    zip.file(`OEBPS/${path}`, bytes);
  }

  const u8 = await zip.generateAsync({ type: "uint8array" });
  return Buffer.from(u8);
}

describe("parseEpub image support", () => {
  it("emits text and image rows in document order", async () => {
    const buf = await buildEpub({
      chapters: [`<p>A</p><img src="../images/foo.jpg" alt="cover"/><p>B</p>`],
      imageFiles: { "images/foo.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
    });
    const parsed = await parseEpub(buf);
    const paras = parsed.chapters[0].paragraphs;
    expect(paras.map((p) => p.kind)).toEqual(["text", "image", "text"]);
    expect(paras[0].text).toBe("A");
    expect(paras[1].alt).toBe("cover");
    expect(paras[1].markup).toContain('src="images/foo.jpg"');
    expect(paras[2].text).toBe("B");
  });

  it("resolves ../ in img src and uses sanitized basename", async () => {
    const buf = await buildEpub({
      chapters: [`<img src="../images/foo.jpg" alt=""/>`],
      imageFiles: { "images/foo.jpg": Buffer.from([0x1]) },
    });
    const parsed = await parseEpub(buf);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0].filename).toBe("foo.jpg");
  });

  it("assigns collision suffixes when two images sanitize to the same name", async () => {
    const buf = await buildEpub({
      chapters: [
        `<img src="../a/p 1.jpg" alt=""/><img src="../b/p 1.jpg" alt=""/>`,
      ],
      imageFiles: {
        "a/p 1.jpg": Buffer.from([0x1]),
        "b/p 1.jpg": Buffer.from([0x2]),
      },
    });
    const parsed = await parseEpub(buf);
    const names = parsed.images.map((i) => i.filename).sort();
    expect(names).toEqual(["p_1-2.jpg", "p_1.jpg"]);
  });

  it("stores alt trimmed; empty string when absent", async () => {
    const buf = await buildEpub({
      chapters: [`<img src="../images/a.jpg" alt="  hi  "/><img src="../images/b.jpg"/>`],
      imageFiles: {
        "images/a.jpg": Buffer.from([0x1]),
        "images/b.jpg": Buffer.from([0x2]),
      },
    });
    const parsed = await parseEpub(buf);
    const paras = parsed.chapters[0].paragraphs;
    expect(paras[0].alt).toBe("hi");
    expect(paras[1].alt).toBe("");
  });

  it("dedups images referenced from multiple chapters", async () => {
    const buf = await buildEpub({
      chapters: [
        `<img src="../images/shared.jpg" alt=""/>`,
        `<img src="../images/shared.jpg" alt=""/>`,
      ],
      imageFiles: { "images/shared.jpg": Buffer.from([0x1]) },
    });
    const parsed = await parseEpub(buf);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.chapters[0].paragraphs[0].markup).toContain(
      'src="images/shared.jpg"',
    );
    expect(parsed.chapters[1].paragraphs[0].markup).toContain(
      'src="images/shared.jpg"',
    );
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run src/lib/epub/__tests__/parser.test.ts`
Expected: all 5 tests PASS. If a test fails, fix the parser (not the test) unless the test itself is wrong per the spec.

- [ ] **Step 4: Commit**

```bash
git add src/lib/epub/__tests__/parser.test.ts package.json pnpm-lock.yaml
git commit -m "test(parser): cover image walker, collision, dedup, alt"
```

---

## Task 4: Upload route persists images and rewrites src

**Files:**
- Modify: `src/app/api/books/upload/route.ts`

**Context:** The upload route currently inserts only chapter-0 paragraphs at upload time (lines 134–146). Other chapters are extracted lazily from `chapter.sourceHtml` inside `enqueueChapterTranslations`. For images to render **before** the user hits Translate, we need two things at upload time:
1. Write every image's bytes to storage (not lazy — images are shared resources).
2. Rewrite every image paragraph's `sourceMarkup` from `images/foo.jpg` to `/api/books/{bookId}/images/foo.jpg` **in both** (a) chapter-0 paragraph inserts and (b) the raw `sourceHtml` stored on every chapter — the lazy extractor in Task 5 rebuilds paragraphs from `sourceHtml`, so the absolute URL must already be baked into `sourceHtml`.

- [ ] **Step 1: Add a src-rewrite helper at module top**

In `src/app/api/books/upload/route.ts`, after the `MAX_SIZE` constant:

```ts
/** Replace every `src="images/{filename}"` (the parser's relative form) with
 * the absolute API route. Operates on raw HTML/markup strings; no parsing
 * required because the parser only emits this exact pattern for image rows. */
function rewriteImageSrcs(html: string, bookId: string): string {
  return html.replace(
    /src="images\/([^"]+)"/g,
    (_m, fname) => `src="/api/books/${bookId}/images/${fname}"`,
  );
}
```

- [ ] **Step 2: Write images to storage after parseEpub**

After `const parsed = await parseEpub(buffer);` (line 51), before the cover write block, add:

```ts
    // Persist images under {bookId}/images/{filename}. Writes happen before
    // the DB transaction so a partial-write failure aborts the upload with
    // no orphaned rows. Storage writes that *do* succeed before a later
    // failure are acceptable garbage (no GC job today — next upload for
    // the same file would just overwrite).
    for (const img of parsed.images) {
      await getUploadsStorage().put(
        `${bookId}/images/${img.filename}`,
        img.bytes,
      );
    }
```

- [ ] **Step 3: Rewrite src in chapter sourceHtml before insert**

In the transaction, replace the `chapterRows` construction (lines 120–127) with:

```ts
      const chapterRows = parsed.chapters.map((ch, i) => ({
        id: randomUUID(),
        bookId,
        index: i,
        title: ch.title,
        sourceHtml: rewriteImageSrcs(ch.sourceHtml, bookId),
        status: "pending" as const,
      }));
```

- [ ] **Step 4: Rewrite src in chapter-0 paragraph markup and persist kind**

Replace the `paragraphRows` construction (lines 136–142) with:

```ts
        const paragraphRows = parsed.chapters[0].paragraphs.map((p, j) => ({
          id: randomUUID(),
          chapterId: firstChapterId,
          seq: j,
          sourceText: p.text,
          sourceMarkup:
            p.kind === "image"
              ? rewriteImageSrcs(p.markup, bookId)
              : p.markup,
          kind: p.kind,
        }));
```

- [ ] **Step 5: Verify types**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/books/upload/route.ts
git commit -m "feat(upload): persist images and rewrite src to API route"
```

---

## Task 5: Lazy extractor walker in enqueue.ts

**Files:**
- Modify: `src/lib/translate/enqueue.ts:32-66`

**Context:** When a chapter other than chapter 0 first needs translation, `enqueueChapterTranslations` parses its `sourceHtml` and inserts paragraph rows (lines 32–66). That code uses `$("body p, p").each(...)` and knows nothing about images. We reuse the parser's walker logic here so lazy-extracted chapters get the same text+image rows as chapter 0 did at upload.

Because `sourceHtml` was already src-rewritten at upload time (Task 4, Step 3), the walker here does NOT need to resolve hrefs or write storage — it just needs to classify each element and preserve the absolute src already baked into the HTML.

- [ ] **Step 1: Replace the lazy extraction block**

Replace the block in `src/lib/translate/enqueue.ts` between `const $ = await import("cheerio")...` (line 42) and the close of the `if (extracted.length > 0)` block (roughly lines 42–66) with:

```ts
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
        if (tag === "img" && !insideParagraph) {
          const src = $(node).attr("src");
          if (!src) return;
          const alt = ($(node).attr("alt") || "").trim();
          // sourceHtml already has rewritten absolute src; reuse the node
          // markup verbatim via $.html.
          const markup = $.html(node) || `<img src="${src}" alt="${alt}">`;
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
```

- [ ] **Step 2: Verify types**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/translate/enqueue.ts
git commit -m "feat(enqueue): lazy extractor emits image rows"
```

---

## Task 6: Translation queries filter kind='text'

**Files:**
- Modify: `src/lib/translate/enqueue.ts` (3 query sites)

**Context:** Image rows must never produce translation jobs. There are three queries that select paragraphs: the main enqueue read (line 25), the re-read after lazy extraction (line 68), and `estimateChapterWork` (line 139). Each needs `and(eq(paragraphs.chapterId, id), eq(paragraphs.kind, "text"))`.

- [ ] **Step 1: Import `and` from drizzle-orm**

At the top of `src/lib/translate/enqueue.ts`, change the drizzle import:

```ts
import { and, eq } from "drizzle-orm";
```

- [ ] **Step 2: Filter the three query sites**

Replace:
```ts
    .where(eq(paragraphs.chapterId, chapterId))
```
at **all three** sites (the initial enqueue read, the post-extract re-read, and `estimateChapterWork`'s read) with:
```ts
    .where(and(eq(paragraphs.chapterId, chapterId), eq(paragraphs.kind, "text")))
```

- [ ] **Step 3: Verify types**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/translate/enqueue.ts
git commit -m "feat(enqueue): skip image rows in translation queries"
```

---

## Task 7: Image serving route

**Files:**
- Create: `src/app/api/books/[id]/images/[filename]/route.ts`

**Context:** Mirrors the existing cover route (`src/app/api/books/[id]/cover/route.ts`) for authz + MIME mapping. Two additional concerns:
1. Path traversal — reject any `filename` containing `..`, `/`, `\`, or NUL.
2. Cache — images never change for a given `(bookId, filename)`, so `immutable` is safe.

- [ ] **Step 1: Write the route**

Create `src/app/api/books/[id]/images/[filename]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { loadBookForRead } from "@/lib/access";
import { getUploadsStorage } from "@/lib/storage";

/**
 * Stream an inline image extracted from the book's EPUB. Authz reuses
 * loadBookForRead so visibility rules stay identical to the book page.
 * filename is sanitized against path traversal; the parser already ensures
 * storage keys use only [A-Za-z0-9._-], so anything outside that set in
 * the URL is a bad-faith request.
 */
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

function isSafeFilename(name: string): boolean {
  if (name.length === 0 || name.length > 256) return false;
  if (name.includes("..")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes("\0")) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; filename: string }> },
) {
  const { id, filename } = await params;
  if (!isSafeFilename(filename)) {
    return NextResponse.json({ error: "Bad filename" }, { status: 400 });
  }

  const { book } = await loadBookForRead(id);
  if (!book) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let bytes: Buffer;
  try {
    bytes = await getUploadsStorage().get(`${id}/images/${filename}`);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const extMatch = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  const mime =
    (extMatch && MIME_BY_EXT[extMatch[1]]) || "application/octet-stream";

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
```

- [ ] **Step 2: Verify types and lint**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npx next lint src/app/api/books/[id]/images`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/books/
git commit -m "feat: serve EPUB inline images via authz-gated route"
```

---

## Task 8: Reader renders image rows

**Files:**
- Modify: `src/components/reader/ColumnView.tsx`
- Modify: `src/app/api/chapters/[id]/route.ts` (verify — likely no change)

**Context:** `ColumnView` receives paragraph objects that today include `{id, seq, sourceText, translations}` (lines 6–14). The chapter API (`src/app/api/chapters/[id]/route.ts`) spreads all paragraph columns via `...p`, so `kind` and `sourceMarkup` will flow through automatically once callers read them — no backend change needed. We just need to (a) widen the frontend type, (b) branch in the render loop to emit `<img>` for image rows, and (c) ensure the row occupies the same slot in each column so the B-pattern (identical image in every column) keeps rows aligned.

- [ ] **Step 1: Widen the Paragraph interface**

In `src/components/reader/ColumnView.tsx:6-14`, update the interface:

```ts
interface Paragraph {
  id: string;
  seq: number;
  sourceText: string;
  sourceMarkup: string;
  kind: "text" | "image";
  translations: Record<
    string,
    { text: string | null; status: string; errorMessage?: string | null }
  >;
}
```

- [ ] **Step 2: Branch in the render loop**

Replace the `.map((p) => { … })` body (lines 134–161) with:

```ts
        {paragraphs.map((p) => {
          if (p.kind === "image") {
            const srcMatch = p.sourceMarkup.match(/src="([^"]+)"/);
            const src = srcMatch ? srcMatch[1] : "";
            return (
              <div key={p.id} className={SPACING_CLASS[paragraphSpacing]}>
                {src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={src}
                    alt={p.sourceText}
                    className="block mx-auto max-w-full h-auto"
                    loading="lazy"
                  />
                ) : null}
              </div>
            );
          }

          const isSource = lang === sourceLang;
          const text = isSource
            ? p.sourceText
            : p.translations[lang]?.text || "";
          const status = isSource ? "done" : p.translations[lang]?.status || "pending";
          const errorMessage = isSource ? null : p.translations[lang]?.errorMessage ?? null;

          return (
            <div key={p.id} className={SPACING_CLASS[paragraphSpacing]}>
              <ParagraphBlock
                id={p.id}
                text={text}
                isHighlighted={highlightedId === p.id}
                onClick={onParagraphClick}
                fontSize={fontSize}
                lineHeight={lineHeight}
                fontFamily={fontFamily}
                status={status}
                errorMessage={errorMessage}
                onRetry={isSource ? undefined : onRetryParagraph}
                retrying={retryingIds?.has(p.id)}
                lang={lang}
                showTts
              />
            </div>
          );
        })}
```

- [ ] **Step 3: Propagate the type through callers**

Grep for where `ColumnView` is imported and called:

Run: `npx tsc --noEmit`

Fix any type errors in callers (likely `ReaderLayout.tsx`) by widening their local `Paragraph` shape to include `kind` and `sourceMarkup`. The chapter API response already carries these fields via `...p` spread; no API change needed.

- [ ] **Step 4: Manual smoke**

Start the dev server:
```bash
pnpm dev
```

Upload a small EPUB with at least one `<img>` (manga chapter fixture, or anything with inline images). Open the reader. Confirm:
- The image renders in all three columns at the same vertical position.
- No "No paragraphs" empty state on a pure-image chapter.
- No translation status dot / retry button overlays the image.

If you can't produce a suitable fixture, say so explicitly and move on — the parser tests (Task 3) cover the data-layer correctness.

- [ ] **Step 5: Commit**

```bash
git add src/components/reader/ColumnView.tsx src/components/reader/ReaderLayout.tsx
git commit -m "feat(reader): render image paragraphs inline"
```

---

## Task 9: Exporter includes images

**Files:**
- Modify: `src/lib/export/exporter.ts`

**Context:** `exportHtmlZip` builds a static HTML zip and `exportJson` dumps a JSON tree. Both currently treat every paragraph as text. We branch on `kind`:
- HTML zip: in each column, emit `<img src="images/{filename}">` for image rows (same image in every column per B-pattern). After chapters are written, pipe each referenced image file from storage into the archive under `images/{filename}`.
- JSON: add `kind` (and the image filename, extracted from `sourceMarkup`, when kind=image) to each paragraph entry.

The `sourceMarkup` stored on image rows contains `src="/api/books/{bookId}/images/{filename}"` (absolute), but inside the zip we want relative `images/{filename}`. Extract the filename with a regex and rebuild the tag.

- [ ] **Step 1: Add a filename-extraction helper**

In `src/lib/export/exporter.ts`, below `escapeHtml`:

```ts
/** Pull the trailing basename out of an image paragraph's sourceMarkup. The
 * upload route rewrites src to /api/books/{bookId}/images/{filename}, so the
 * basename is everything after the last "/". Returns null if no src attr. */
function imageFilenameFromMarkup(markup: string): string | null {
  const m = markup.match(/src="([^"]+)"/);
  if (!m) return null;
  const src = m[1];
  const slash = src.lastIndexOf("/");
  return slash >= 0 ? src.substring(slash + 1) : src;
}
```

- [ ] **Step 2: Branch in `exportHtmlZip`**

Inside the per-column loop in `exportHtmlZip` (around lines 165–177), replace the text-only emission:

```ts
    for (const lang of allLangs) {
      chHtml += `<div class="col"><h3>${LANG_LABELS[lang] || lang}</h3>`;
      for (const p of paras) {
        if (p.kind === "image") {
          const fname = imageFilenameFromMarkup(p.sourceMarkup);
          chHtml += fname
            ? `<img src="images/${fname}" alt="${escapeHtml(p.sourceText)}" style="max-width:100%;height:auto;display:block;margin:1em auto"/>`
            : "";
          continue;
        }
        if (lang === sourceLang) {
          chHtml += `<p>${escapeHtml(p.sourceText)}</p>`;
        } else {
          const trans = paraTranslations.get(p.id) || [];
          const t = trans.find((tr) => tr.lang === lang && tr.status === "done");
          chHtml += `<p>${t?.text ? escapeHtml(t.text) : "<em>未翻译</em>"}</p>`;
        }
      }
      chHtml += "</div>";
    }
```

- [ ] **Step 3: Collect referenced filenames and pipe image files into the archive**

Above the `for (const ch of chapterList)` loop (around line 139), declare a set:

```ts
  const referencedImages = new Set<string>();
```

Inside the per-paragraph loop, when you hit a kind=image row, add the filename:

```ts
        if (p.kind === "image") {
          const fname = imageFilenameFromMarkup(p.sourceMarkup);
          if (fname) referencedImages.add(fname);
          // …render branch as in Step 2…
```

After all chapter HTML has been appended to the archive (after the `indexHtml` append, before `await archive.finalize()`), pipe each image into the zip:

```ts
  for (const fname of referencedImages) {
    try {
      const bytes = await getUploadsStorage().get(`${bookId}/images/${fname}`);
      archive.append(bytes, { name: `images/${fname}` });
    } catch {
      // Skip missing images silently — the <img> tag in the HTML will 404
      // in the exported copy but the rest of the book is still readable.
    }
  }
```

Add the import at the top of the file:

```ts
import { getUploadsStorage, getExportsStorage } from "@/lib/storage";
```

- [ ] **Step 4: Add `kind` to `exportJson` output**

In `exportJson` (lines 42–60), replace the `paraData` construction with:

```ts
      const paraData = await Promise.all(
        paras.map(async (p) => {
          const trans = await db
            .select()
            .from(translations)
            .where(eq(translations.paragraphId, p.id))
            .all();

          const base = {
            seq: p.seq,
            kind: p.kind,
            source: p.sourceText,
            translations: Object.fromEntries(
              trans
                .filter((t) => t.status === "done")
                .map((t) => [t.lang, t.text]),
            ),
          };
          if (p.kind === "image") {
            const filename = imageFilenameFromMarkup(p.sourceMarkup);
            return filename ? { ...base, image: { filename } } : base;
          }
          return base;
        }),
      );
```

- [ ] **Step 5: Verify types and manual smoke**

Run: `npx tsc --noEmit`
Expected: PASS.

Manual: export a book with images via the existing export endpoint, open the zip, confirm `images/` folder is present and chapter HTML references `images/{filename}` that resolves inside the zip.

- [ ] **Step 6: Commit**

```bash
git add src/lib/export/exporter.ts
git commit -m "feat(export): include images in HTML zip and JSON"
```

---

## Self-review

**Spec coverage:**
- §1 Parser — Tasks 2, 3.
- §2 Upload route — Task 4.
- §3 Schema migration — Task 1.
- §4 Translation pipeline — Tasks 5, 6.
- §5 Image serving route — Task 7.
- §6 Reader — Task 8.
- §7 Exporter — Task 9.
- §8 Tests — Task 3.

**Placeholder scan:** No TBDs, no "handle edge cases", no "similar to Task N". Each code step has complete copy-pasteable code.

**Type consistency:**
- `ParsedParagraph.kind` is `"text" | "image"` in parser, schema, lazy extractor, upload route, reader, exporter.
- `ParsedImage.filename` matches storage key under `{bookId}/images/{filename}` in upload, image route, exporter.
- Helper name `rewriteImageSrcs` consistent between Task 4 steps.
- `imageFilenameFromMarkup` defined once and reused in Task 9.

**Decisions:**
- Parser walker resolves `<img src>` against chapter-file directory, not OPF directory — correct per EPUB spec and tested in Task 3 (`../images/foo.jpg` case).
- `sourceHtml` rewrite happens at upload so the lazy extractor (Task 5) sees absolute URLs without knowing `bookId`.
- Image rows skip translation via `kind='text'` filter, not by deleting rows — keeps seq stable for reader alignment.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-15-epub-image-support.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task with spec + code-quality review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for your review.

Which approach?
