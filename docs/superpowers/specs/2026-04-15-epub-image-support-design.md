# EPUB Image Support — Design

**Status:** Approved
**Date:** 2026-04-15

## Goal

Render inline images from EPUB source files in the trilingual reader so that
image-heavy chapters (manga pages, cover plates, diagrams) no longer show the
"No paragraphs" empty state. Images appear in their original document
position, repeated in each of the three language columns.

## Non-goals

- Translation of `alt` text. Alt text is stored but not sent to the LLM.
- Image compression, resizing, or format conversion. EPUB bytes are served
  as-is.
- Backfill of existing books. Current data will be wiped before this ships;
  users re-upload to get image support.
- SVG inline manipulation. SVG files are served via `<img>` like any other
  raster format; we do not inline or sanitize their contents.
- Per-column image variants (e.g., translated infographics). The same image
  renders identically in all three columns.

## Architecture overview

The existing content flow is:

```
EPUB upload → parseEpub() → chapters + paragraphs rows → reader renders paragraphs
                                                       → worker translates paragraphs
                                                       → exporter emits HTML/JSON
```

We keep this flow intact and add images as a second kind of row in the
existing `paragraphs` table, distinguished by a new `kind` column. The
translation pipeline filters to `kind = 'text'`; the reader and exporter
render both kinds in `seq` order.

Image bytes are extracted at upload time and written to the existing uploads
storage backend (fs or R2) at `{bookId}/images/{filename}`. A new authz-gated
route streams them back to the browser.

## Components

### 1. Parser (`src/lib/epub/parser.ts`)

**Changes:**
- Extend `ParsedParagraph` with `kind: "text" | "image"`.
- Add `alt?: string` (image paragraphs only). Empty string when the EPUB
  omits `alt`.
- Extend `ParsedEpub` with a top-level `images: ParsedImage[]` array, where
  `ParsedImage = { filename: string; bytes: Buffer; contentType: string }`.
  This is the deduped set of images referenced by at least one chapter; the
  upload route writes them to storage in one pass rather than per-chapter.
- When walking a chapter's HTML, iterate `body p, body img` in document
  order (cheerio traversal preserves DOM order across selectors). Each `<p>`
  yields a text paragraph as today; each `<img>` yields an image paragraph
  with:
  - `text = alt?.trim() ?? ""`
  - `markup = <img src="images/{filename}" alt="…">` where `filename` is the
    sanitized basename (see below). The src is a relative path; the upload
    route rewrites it to the API route before insert.
  - `kind = "image"`
  - `alt` set

**Filename sanitization:**
- Take the image href from the `<img src="…">` resolved against the OPF
  directory.
- Basename only; strip any directory components.
- Keep `[A-Za-z0-9._-]`, replace everything else with `_`.
- On collision within the same upload (distinct sources sanitize to the same
  name), append `-2`, `-3`, … before the extension.

**Dedup:** If the same href appears in multiple chapters, emit the image
bytes once in `ParsedEpub.images`. Each chapter's paragraph still references
it by filename.

**Image content types:** Accept whatever the EPUB manifest declares
(`image/*`). Reuse the existing `extFromMime` / `mimeFromExt` helpers.

### 2. Upload route (`src/app/api/books/upload/route.ts`)

**New steps, in order:**
1. After `parseEpub`, iterate `parsed.images` and write each to
   `getUploadsStorage().put(\`${bookId}/images/${filename}\`, bytes)`.
2. Before inserting paragraphs, rewrite every image paragraph's `sourceMarkup`
   to replace `src="images/{filename}"` with
   `src="/api/books/{bookId}/images/{filename}"`. The rewrite is a simple
   string replace on the serialized markup; no HTML re-parse required.
3. Insert paragraphs with the new `kind` column populated.

Bulk inserts stay in the existing transaction from Task 5; images are
written to storage *before* the transaction since blob writes can't be
rolled back with the DB. Failed image writes abort the upload before any
row is inserted.

### 3. Schema migration (`drizzle/`)

New migration adds:
```sql
ALTER TABLE paragraphs ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
```

`paragraphs.kind` in `src/lib/db/schema.ts` gets a matching column with
TypeScript union type `"text" | "image"`. Default is `"text"` so existing
code paths that insert without specifying `kind` continue to work.

### 4. Translation pipeline

**Enqueue (`src/lib/translate/enqueue.ts`):** Filter the paragraphs query
to `kind = 'text'` before building translation rows. Image paragraphs never
enter the `translations` table.

**Estimator (`estimateChapterWork`):** Same filter. Image paragraphs
contribute zero to the character count, so pricing reflects only translated
text.

**Executor (`src/lib/llm/executor.ts`):** No change. It looks up work by
`translation.id`, and image paragraphs have no translation rows.

**Cancel (`src/lib/translate/cancel.ts`):** No change. Only acts on
translation rows.

### 5. Image serving route

New file: `src/app/api/books/[bookId]/images/[filename]/route.ts`

**Behavior:**
- `GET` only.
- Authz: same rule as `GET /api/books/[id]` — public books (admin-owned,
  visibility = `public`) plus owner + admin. Reuse whichever helper the
  book-read route uses.
- Sanitize `filename` against path traversal (reject anything containing
  `..` or `/` or `\`).
- Read from `getUploadsStorage().get(\`${bookId}/images/${filename}\`)`.
  404 if missing.
- Return bytes with `Content-Type` from file extension (reuse
  `mimeFromExt`) and `Cache-Control: public, max-age=31536000, immutable`.
  Filenames include the original EPUB-side name; no cache bust needed
  because the bytes don't change for a given (book, filename).

### 6. Reader (`src/components/reader/ReaderLayout.tsx`)

**Rendering:** When iterating paragraphs in each column, branch on `kind`:
- `kind === "text"`: current behavior (render source text + translation).
- `kind === "image"`: render a single `<img>` element using `sourceMarkup`'s
  src. Styling: `max-width: 100%; height: auto; display: block; margin: 1em
  auto;`. Wrap in the same outer container that text paragraphs use so the
  vertical rhythm matches — the image row occupies the same slot in the
  per-column flex/grid that a text paragraph would, which is what keeps the
  three columns aligned row-for-row (B-option: identical image in every
  column).

**Translation UI:** Image paragraphs skip:
- Status dots (pending/translating/done)
- Retry button
- Word-tap vocab tooltip

**Progress computation:** If the reader shows a per-chapter progress bar
(translated/total paragraphs), the denominator is text-paragraph count,
not total rows. Check the current implementation — if it already queries
translations, the filter is implicit and nothing changes.

**Empty-state:** "No paragraphs" text stays but only triggers when the
chapter has zero rows of either kind. A pure-image chapter has image rows
and therefore renders content instead of the empty state.

### 7. Exporter (`src/lib/export/exporter.ts`)

**HTML zip (`exportHtmlZip`):**
- In the chapter HTML template, branch on `p.kind`:
  - `text` → current `<p>{source}</p>` / `<p>{translation}</p>`
  - `image` → `<img src="images/{filename}" …>` in every column (same B
    pattern as the reader)
- In the outer archive, after text chapters are written, pipe each
  referenced image from storage (`getUploadsStorage().get()`) into the
  archive under `images/{filename}`.
- The inline `<img>` src is `images/{filename}` — relative inside the zip.

**JSON export (`exportJson`):** Add `kind` and the image filename to each
paragraph. Consumers that don't care about images see the extra field and
ignore it; consumers that do can download images separately by calling
the image route or parsing the original book.

### 8. Tests

**Parser unit tests (new file if needed):**
- Simple HTML with `<p>A</p><img src="foo.jpg"><p>B</p>` yields three
  paragraphs in order with kinds `[text, image, text]`.
- `src="../images/foo.jpg"` resolves correctly and the filename becomes
  `foo.jpg`.
- Collisions: two images at different manifest paths whose basenames
  sanitize to the same string (e.g. `img/a b.jpg` and `cover/a b.jpg`
  both become `a_b.jpg`) get deterministic suffixes `a_b.jpg`, `a_b-2.jpg`.
- Alt text extracted and trimmed; missing alt stored as empty string.
- Dedup: same href referenced from two chapters yields one entry in
  `ParsedEpub.images` and two paragraph rows with the same filename.

**Route tests:** Minimal — we don't have heavy test coverage of routes.
Manual verification during smoke-test covers the rest.

**Reader tests:** None. Visual, covered by manual smoke.

## Data flow for a new image-heavy EPUB

1. User uploads `manga.epub`.
2. Server parses. Chapter 1 has three `<p>` and two `<img>` in order.
3. Parser returns:
   - `chapters[0].paragraphs = [{kind:"text",…}, {kind:"text",…}, {kind:"image",alt:"cover",…}, {kind:"text",…}, {kind:"image",alt:"",…}]`
   - `images = [{filename:"p001.jpg", bytes:…, …}, {filename:"p002.jpg", …}]`
4. Upload route writes `{bookId}/images/p001.jpg` and `{bookId}/images/p002.jpg` to storage.
5. Upload route rewrites each image paragraph's `sourceMarkup` src from
   `images/p001.jpg` to `/api/books/{bookId}/images/p001.jpg`.
6. Transaction inserts book, chapters, paragraphs (5 rows for chapter 1,
   `kind` populated per row).
7. User clicks Translate. `enqueueChapterTranslations` inserts translation
   rows for the three text paragraphs only.
8. Worker processes the three text translations. Image rows are untouched.
9. Reader loads chapter 1, iterates paragraphs by seq, renders text rows as
   source + translations and image rows as `<img>` in each column.

## Error handling

- **Parser encounters an unreadable image file:** log, skip that image, still
  emit the paragraph row so the document flow isn't broken but the markup
  gets a `data-broken="true"` attribute that the reader can style as a
  placeholder. (If even one broken image is rare, we can drop the placeholder
  and just skip the row — decide during implementation based on real EPUB
  files.)
- **Image storage write fails:** abort upload, return 500, nothing written
  to DB. Partial storage writes are acceptable garbage (next upload attempt
  will overwrite or leave orphaned files); a GC job is out of scope.
- **Image GET with bad filename (path traversal, null bytes):** 400.
- **Image GET for a book the user can't read:** 403.
- **Image GET for a filename the book doesn't have:** 404.

## Rollout

This feature ships as one sequenced plan: schema migration first, then
parser + upload + storage + routes + reader + exporter. Each task has its
own tests and commit. No feature flag; the `kind` column defaults to
`"text"` so pre-existing inserts keep working. Fresh-start data wipe
happens before the first upload exercises the new path.
