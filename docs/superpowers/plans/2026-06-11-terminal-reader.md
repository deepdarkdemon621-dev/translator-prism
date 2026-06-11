# Terminal Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Windows PowerShell/Windows Terminal reader for uploaded books that can show source-only, bilingual, or trilingual paragraph blocks from the existing database.

**Architecture:** Add a local-only `npm run read` CLI that loads `.env.local`, reads book/chapter/paragraph/translation data through small shared reader helpers, renders terminal-safe text blocks, and handles keyboard navigation in the script layer. Do not reuse React reader components; reuse the database schema and reader language-selection concepts where practical.

**Tech Stack:** TypeScript, `tsx`, Node.js built-ins, Drizzle/libSQL, Vitest. No new runtime dependency for the MVP.

---

## Development Standards

- This is a local tool, not a hosted web feature. It may trust local environment variables but must not bypass or weaken web-route authorization.
- Load `.env.local` first, then `.env`, matching `src/lib/db/migrate.ts`.
- Do not initialize DB clients at module scope before env loading. `scripts/read.ts` must load env before dynamically importing DB-backed helpers.
- Do not trigger translation jobs from the terminal reader in MVP.
- Do not write web `reading_progress` rows in MVP because Clerk identity is not available in a local terminal. Use a local JSON progress file.
- Terminal output must be plain text. Images render as `[image]`; HTML markup is stripped or collapsed.
- Use vertical paragraph blocks instead of side-by-side columns because CJK width handling in Windows terminals is unreliable.
- Default language mode is `auto`: source language first, then available translation languages in reader order.
- Keyboard shortcuts:
  - `1`: source only
  - `2`: source + first translation language
  - `3`: source + second translation language
  - `4`: source + all available languages
  - `n` or `right`: next page
  - `p` or `left`: previous page
  - `]`: next chapter
  - `[`: previous chapter
  - `q` or `ctrl+c`: quit
- Keep test coverage focused on pure formatting, local progress persistence, data-shaping, and CLI argument parsing. Avoid brittle full-terminal snapshot tests.

## Command Contract

Add this script:

```json
{
  "scripts": {
    "read": "tsx scripts/read.ts"
  }
}
```

Supported commands:

```powershell
npm run read -- --book <bookId>
npm run read -- --book <bookId> --langs auto
npm run read -- --book <bookId> --langs ja,zh
npm run read -- --book <bookId> --langs ja,zh,en
npm run read -- --book <bookId> --chapter 3
```

MVP output shape:

```text
Prism Terminal Reader
Book: Example Book
Chapter 3/18: Chapter Title
Mode: ja, zh, en

[12]
JA  これはテストです。
ZH  这是一个测试。
EN  This is a test.

n next page | p prev page | [ prev chapter | ] next chapter | 1/2/3/4 mode | q quit
```

## File Structure

- Create: `scripts/read.ts`
  - CLI entry point, env loading, argument parsing, keyboard loop, screen rendering.
- Create: `src/lib/reader/terminal-data.ts`
  - DB-backed book/chapter/content loading helpers.
- Create: `src/lib/reader/terminal-format.ts`
  - Pure functions for language mode selection, HTML-to-terminal text, paragraph block rendering, pagination.
- Create: `src/lib/reader/terminal-progress.ts`
  - Local JSON progress persistence under `data/terminal-progress.json`.
- Create: `src/lib/reader/__tests__/terminal-format.test.ts`
  - Pure formatting and language mode tests.
- Create: `src/lib/reader/__tests__/terminal-progress.test.ts`
  - Temp-directory progress read/write tests.
- Create: `src/lib/reader/__tests__/terminal-data.test.ts`
  - libSQL in-memory data-shaping tests.
- Modify: `package.json`
  - Add `read` script.

---

## Task 1: Terminal Formatting Helpers

**Files:**
- Create: `src/lib/reader/terminal-format.ts`
- Test: `src/lib/reader/__tests__/terminal-format.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/reader/__tests__/terminal-format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  normalizeTerminalLangs,
  renderParagraphBlock,
  stripHtmlForTerminal,
  paginateParagraphs,
  type TerminalParagraph,
} from "@/lib/reader/terminal-format";

const paragraph: TerminalParagraph = {
  seq: 12,
  kind: "text",
  sourceLang: "ja",
  sourceText: "これはテストです。",
  translations: {
    zh: { text: "这是一个测试。", status: "done" },
    en: { text: "This is a test.", status: "done" },
  },
};

describe("terminal reader formatting", () => {
  it("normalizes auto mode to source language plus available translations", () => {
    expect(
      normalizeTerminalLangs({
        requested: "auto",
        sourceLang: "ja",
        availableLangs: ["zh", "en"],
      }),
    ).toEqual(["ja", "zh", "en"]);
  });

  it("keeps requested languages in user order while removing unknown values", () => {
    expect(
      normalizeTerminalLangs({
        requested: "ja,xx,en,ja",
        sourceLang: "ja",
        availableLangs: ["zh", "en"],
      }),
    ).toEqual(["ja", "en"]);
  });

  it("renders a vertical trilingual paragraph block", () => {
    expect(renderParagraphBlock(paragraph, ["ja", "zh", "en"])).toBe(
      [
        "[12]",
        "JA  これはテストです。",
        "ZH  这是一个测试。",
        "EN  This is a test.",
      ].join("\n"),
    );
  });

  it("shows translation status when text is not done", () => {
    expect(
      renderParagraphBlock(
        {
          ...paragraph,
          translations: { zh: { text: "", status: "pending" } },
        },
        ["ja", "zh"],
      ),
    ).toContain("ZH  [pending]");
  });

  it("strips html tags and collapses whitespace", () => {
    expect(stripHtmlForTerminal("<p>Hello <strong>world</strong></p>")).toBe(
      "Hello world",
    );
  });

  it("paginates paragraph arrays by count", () => {
    const paragraphs = Array.from({ length: 7 }, (_, i) => ({
      ...paragraph,
      seq: i + 1,
    }));

    expect(paginateParagraphs(paragraphs, 1, 3).map((p) => p.seq)).toEqual([
      4,
      5,
      6,
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npx vitest run src/lib/reader/__tests__/terminal-format.test.ts
```

Expected: FAIL with module-not-found for `terminal-format`.

- [ ] **Step 3: Implement formatting helpers**

Create `src/lib/reader/terminal-format.ts`:

```ts
import { DEFAULT_LANG_ORDER, type ReaderLang } from "@/lib/reader/language-selection";

const READER_LANGS = new Set<string>(DEFAULT_LANG_ORDER);

export interface TerminalTranslation {
  text: string | null;
  status: string;
  errorMessage?: string | null;
}

export interface TerminalParagraph {
  seq: number;
  kind: "text" | "image";
  sourceLang: string;
  sourceText: string;
  translations: Record<string, TerminalTranslation>;
}

export function normalizeTerminalLangs(params: {
  requested: string | undefined;
  sourceLang: string;
  availableLangs: string[];
}): ReaderLang[] {
  const { requested, sourceLang, availableLangs } = params;
  const available = new Set([sourceLang, ...availableLangs]);
  const pushUnique = (target: ReaderLang[], lang: string) => {
    if (READER_LANGS.has(lang) && available.has(lang) && !target.includes(lang as ReaderLang)) {
      target.push(lang as ReaderLang);
    }
  };

  const result: ReaderLang[] = [];
  if (!requested || requested === "auto") {
    pushUnique(result, sourceLang);
    for (const lang of DEFAULT_LANG_ORDER) pushUnique(result, lang);
    return result;
  }

  for (const raw of requested.split(",")) {
    pushUnique(result, raw.trim().toLowerCase());
  }
  if (result.length === 0) {
    pushUnique(result, sourceLang);
  }
  return result;
}

export function stripHtmlForTerminal(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function renderParagraphBlock(
  paragraph: TerminalParagraph,
  langs: ReaderLang[],
): string {
  if (paragraph.kind === "image") {
    return [`[${paragraph.seq}]`, "IMG [image]"].join("\n");
  }

  const lines = [`[${paragraph.seq}]`];
  for (const lang of langs) {
    const label = lang.toUpperCase().padEnd(3, " ");
    if (lang === paragraph.sourceLang) {
      lines.push(`${label} ${paragraph.sourceText}`);
      continue;
    }

    const translation = paragraph.translations[lang];
    const text =
      translation?.status === "done" && translation.text
        ? translation.text
        : `[${translation?.status ?? "missing"}]`;
    lines.push(`${label} ${text}`);
  }
  return lines.join("\n");
}

export function paginateParagraphs<T>(
  paragraphs: T[],
  page: number,
  pageSize: number,
): T[] {
  const start = Math.max(0, page) * pageSize;
  return paragraphs.slice(start, start + pageSize);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npx vitest run src/lib/reader/__tests__/terminal-format.test.ts
```

Expected: PASS.

---

## Task 2: Local Terminal Progress Store

**Files:**
- Create: `src/lib/reader/terminal-progress.ts`
- Test: `src/lib/reader/__tests__/terminal-progress.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/reader/__tests__/terminal-progress.test.ts`:

```ts
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadTerminalProgress,
  saveTerminalProgress,
} from "@/lib/reader/terminal-progress";

describe("terminal progress store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "terminal-reader-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults when no progress file exists", () => {
    expect(loadTerminalProgress("book-1", { dataDir: dir })).toEqual({
      chapterIndex: 0,
      page: 0,
      langs: "auto",
    });
  });

  it("saves and reloads progress for a book", () => {
    saveTerminalProgress(
      "book-1",
      { chapterIndex: 2, page: 4, langs: "ja,zh" },
      { dataDir: dir },
    );

    expect(loadTerminalProgress("book-1", { dataDir: dir })).toEqual({
      chapterIndex: 2,
      page: 4,
      langs: "ja,zh",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npx vitest run src/lib/reader/__tests__/terminal-progress.test.ts
```

Expected: FAIL with module-not-found for `terminal-progress`.

- [ ] **Step 3: Implement progress store**

Create `src/lib/reader/terminal-progress.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface TerminalProgress {
  chapterIndex: number;
  page: number;
  langs: string;
}

interface ProgressOptions {
  dataDir?: string;
}

const DEFAULT_PROGRESS: TerminalProgress = {
  chapterIndex: 0,
  page: 0,
  langs: "auto",
};

function progressPath(options: ProgressOptions = {}): string {
  return join(options.dataDir ?? join(process.cwd(), "data"), "terminal-progress.json");
}

function readAll(options: ProgressOptions = {}): Record<string, TerminalProgress> {
  const file = progressPath(options);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, TerminalProgress>;
  } catch {
    return {};
  }
}

export function loadTerminalProgress(
  bookId: string,
  options: ProgressOptions = {},
): TerminalProgress {
  return readAll(options)[bookId] ?? DEFAULT_PROGRESS;
}

export function saveTerminalProgress(
  bookId: string,
  progress: TerminalProgress,
  options: ProgressOptions = {},
): void {
  const file = progressPath(options);
  mkdirSync(options.dataDir ?? join(process.cwd(), "data"), { recursive: true });
  const all = readAll(options);
  all[bookId] = progress;
  writeFileSync(file, JSON.stringify(all, null, 2), "utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npx vitest run src/lib/reader/__tests__/terminal-progress.test.ts
```

Expected: PASS.

---

## Task 3: Terminal Reader Data Queries

**Files:**
- Create: `src/lib/reader/terminal-data.ts`
- Test: `src/lib/reader/__tests__/terminal-data.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/reader/__tests__/terminal-data.test.ts`:

```ts
import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "@/lib/db/schema";
import {
  loadTerminalBook,
  loadTerminalChapter,
} from "@/lib/reader/terminal-data";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

describe("terminal reader data queries", () => {
  let client: Client;
  let db: TestDb;

  beforeAll(async () => {
    client = createClient({ url: "file::memory:" });
    await migrate(drizzle(client, { schema }), { migrationsFolder: "./drizzle" });
    db = drizzle(client, { schema });
  });

  afterAll(() => client.close());

  beforeEach(async () => {
    await db.delete(schema.translations).run();
    await db.delete(schema.paragraphs).run();
    await db.delete(schema.chapters).run();
    await db.delete(schema.books).run();
  });

  it("loads book metadata and chapter list", async () => {
    await db.insert(schema.books).values({
      id: "book-1",
      title: "Book",
      author: "Author",
      sourceLang: "ja",
      filePath: "book-1.epub",
      totalChapters: 1,
      status: "parsed",
    }).run();
    await db.insert(schema.chapters).values({
      id: "chapter-1",
      bookId: "book-1",
      index: 0,
      title: "Chapter 1",
      sourceHtml: "<p>x</p>",
      status: "done",
    }).run();

    await expect(loadTerminalBook(db, "book-1")).resolves.toMatchObject({
      id: "book-1",
      title: "Book",
      sourceLang: "ja",
      chapters: [{ id: "chapter-1", index: 0, title: "Chapter 1", status: "done" }],
    });
  });

  it("loads chapter paragraphs with translations in one shaped result", async () => {
    await db.insert(schema.books).values({
      id: "book-1",
      title: "Book",
      author: "Author",
      sourceLang: "ja",
      filePath: "book-1.epub",
      totalChapters: 1,
      status: "parsed",
    }).run();
    await db.insert(schema.chapters).values({
      id: "chapter-1",
      bookId: "book-1",
      index: 0,
      title: "Chapter 1",
      sourceHtml: "<p>x</p>",
      status: "done",
    }).run();
    await db.insert(schema.paragraphs).values({
      id: "paragraph-1",
      chapterId: "chapter-1",
      seq: 0,
      sourceText: "原文",
      sourceMarkup: "<p>原文</p>",
      kind: "text",
    }).run();
    await db.insert(schema.translations).values({
      id: "translation-1",
      paragraphId: "paragraph-1",
      lang: "zh",
      text: "译文",
      status: "done",
    }).run();

    await expect(loadTerminalChapter(db, "chapter-1", "ja")).resolves.toMatchObject({
      id: "chapter-1",
      paragraphs: [
        {
          seq: 0,
          sourceLang: "ja",
          sourceText: "原文",
          translations: { zh: { text: "译文", status: "done" } },
        },
      ],
      availableLangs: ["zh"],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npx vitest run src/lib/reader/__tests__/terminal-data.test.ts
```

Expected: FAIL with module-not-found for `terminal-data`.

- [ ] **Step 3: Implement terminal data queries**

Create `src/lib/reader/terminal-data.ts`:

```ts
import { asc, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/lib/db";
import { books, chapters, paragraphs, translations } from "@/lib/db/schema";
import type { TerminalParagraph, TerminalTranslation } from "@/lib/reader/terminal-format";

type ReaderDb = ReturnType<typeof getDb>;

export interface TerminalChapterSummary {
  id: string;
  index: number;
  title: string;
  status: string;
}

export interface TerminalBook {
  id: string;
  title: string;
  author: string;
  sourceLang: string;
  chapters: TerminalChapterSummary[];
}

export interface TerminalChapter {
  id: string;
  title: string;
  status: string;
  paragraphs: TerminalParagraph[];
  availableLangs: string[];
}

export async function loadTerminalBook(
  db: ReaderDb,
  bookId: string,
): Promise<TerminalBook | null> {
  const book = await db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book) return null;

  const chapterRows = await db
    .select({
      id: chapters.id,
      index: chapters.index,
      title: chapters.title,
      status: chapters.status,
    })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.index))
    .all();

  return {
    id: book.id,
    title: book.title,
    author: book.author,
    sourceLang: book.sourceLang,
    chapters: chapterRows,
  };
}

export async function loadTerminalChapter(
  db: ReaderDb,
  chapterId: string,
  sourceLang: string,
): Promise<TerminalChapter | null> {
  const chapter = await db
    .select({
      id: chapters.id,
      title: chapters.title,
      status: chapters.status,
    })
    .from(chapters)
    .where(eq(chapters.id, chapterId))
    .get();
  if (!chapter) return null;

  const paraRows = await db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, chapterId))
    .orderBy(asc(paragraphs.seq))
    .all();

  const paraIds = paraRows.map((paragraph) => paragraph.id);
  const translationRows = paraIds.length
    ? await db
        .select()
        .from(translations)
        .where(inArray(translations.paragraphId, paraIds))
        .all()
    : [];

  const byParagraph = new Map<string, Record<string, TerminalTranslation>>();
  const available = new Set<string>();
  for (const translation of translationRows) {
    let bucket = byParagraph.get(translation.paragraphId);
    if (!bucket) {
      bucket = {};
      byParagraph.set(translation.paragraphId, bucket);
    }
    bucket[translation.lang] = {
      text: translation.text,
      status: translation.status,
      errorMessage: translation.errorMessage,
    };
    available.add(translation.lang);
  }

  return {
    ...chapter,
    paragraphs: paraRows.map((paragraph) => ({
      seq: paragraph.seq,
      kind: paragraph.kind,
      sourceLang,
      sourceText: paragraph.kind === "image" ? "[image]" : paragraph.sourceText,
      translations: byParagraph.get(paragraph.id) ?? {},
    })),
    availableLangs: Array.from(available).sort(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npx vitest run src/lib/reader/__tests__/terminal-data.test.ts
```

Expected: PASS.

---

## Task 4: CLI Entrypoint and Keyboard Loop

**Files:**
- Create: `scripts/read.ts`
- Modify: `package.json`

- [ ] **Step 1: Add package script**

Modify `package.json`:

```json
{
  "scripts": {
    "read": "tsx scripts/read.ts"
  }
}
```

- [ ] **Step 2: Create CLI entrypoint**

Create `scripts/read.ts`:

```ts
import { config as loadEnv } from "dotenv";
import path from "path";
import readline from "readline";

loadEnv({ path: path.join(process.cwd(), ".env.local") });
loadEnv();

interface Args {
  bookId: string;
  langs: string;
  chapterIndex?: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const bookId = get("--book");
  if (!bookId) {
    throw new Error("Usage: npm run read -- --book <bookId> [--langs auto|ja,zh,en] [--chapter 3]");
  }
  const chapterRaw = get("--chapter");
  return {
    bookId,
    langs: get("--langs") ?? "auto",
    chapterIndex: chapterRaw ? Math.max(0, Number(chapterRaw) - 1) : undefined,
  };
}

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { getDb } = await import("@/lib/db");
  const { loadTerminalBook, loadTerminalChapter } = await import("@/lib/reader/terminal-data");
  const {
    normalizeTerminalLangs,
    paginateParagraphs,
    renderParagraphBlock,
  } = await import("@/lib/reader/terminal-format");
  const {
    loadTerminalProgress,
    saveTerminalProgress,
  } = await import("@/lib/reader/terminal-progress");

  const db = getDb();
  const book = await loadTerminalBook(db, args.bookId);
  if (!book) throw new Error(`Book not found: ${args.bookId}`);

  const saved = loadTerminalProgress(args.bookId);
  let chapterIndex = args.chapterIndex ?? saved.chapterIndex;
  let page = saved.page;
  let langArg = args.langs === "auto" ? saved.langs : args.langs;
  const pageSize = 8;

  const render = async () => {
    const chapterSummary = book.chapters[chapterIndex] ?? book.chapters[0];
    if (!chapterSummary) throw new Error("Book has no chapters");
    const chapter = await loadTerminalChapter(db, chapterSummary.id, book.sourceLang);
    if (!chapter) throw new Error(`Chapter not found: ${chapterSummary.id}`);

    const langs = normalizeTerminalLangs({
      requested: langArg,
      sourceLang: book.sourceLang,
      availableLangs: chapter.availableLangs,
    });
    const pages = Math.max(1, Math.ceil(chapter.paragraphs.length / pageSize));
    page = Math.min(Math.max(0, page), pages - 1);

    clearScreen();
    console.log("Prism Terminal Reader");
    console.log(`Book: ${book.title}`);
    console.log(`Chapter ${chapterSummary.index + 1}/${book.chapters.length}: ${chapter.title}`);
    console.log(`Page ${page + 1}/${pages}`);
    console.log(`Mode: ${langs.join(", ")}`);
    console.log("");
    for (const paragraph of paginateParagraphs(chapter.paragraphs, page, pageSize)) {
      console.log(renderParagraphBlock(paragraph, langs));
      console.log("");
    }
    console.log("n next | p prev | ] next chapter | [ prev chapter | 1/2/3/4 mode | q quit");

    saveTerminalProgress(args.bookId, { chapterIndex, page, langs: langArg });
  };

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  await render();

  process.stdin.on("keypress", async (_str, key) => {
    if (key.ctrl && key.name === "c") process.exit(0);
    if (key.name === "q") process.exit(0);
    if (key.name === "n" || key.name === "right") page += 1;
    if (key.name === "p" || key.name === "left") page -= 1;
    if (key.sequence === "]") {
      chapterIndex = Math.min(book.chapters.length - 1, chapterIndex + 1);
      page = 0;
    }
    if (key.sequence === "[") {
      chapterIndex = Math.max(0, chapterIndex - 1);
      page = 0;
    }
    if (key.name === "1") langArg = book.sourceLang;
    if (key.name === "2") langArg = `${book.sourceLang},zh`;
    if (key.name === "3") langArg = `${book.sourceLang},en`;
    if (key.name === "4") langArg = "auto";
    await render().catch((err) => {
      console.error(err instanceof Error ? err.message : err);
    });
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 3: Run command without args**

Run:

```powershell
npm run read
```

Expected: exits non-zero and prints:

```text
Usage: npm run read -- --book <bookId> [--langs auto|ja,zh,en] [--chapter 3]
```

- [ ] **Step 4: Run command with a real book**

Run:

```powershell
npm run read -- --book <existing-book-id> --langs auto
```

Expected: terminal clears, prints book/chapter header, renders paragraph blocks, and responds to `n`, `p`, `[`, `]`, `1`, `2`, `3`, `4`, `q`.

---

## Task 5: Verification and Documentation

**Files:**
- Modify: `AI_TASK_BOARD.md`
- Modify: `AI_HANDOFF_SUMMARY.md`
- Modify: `AI_SESSION_ENTRY.md`

- [ ] **Step 1: Run focused test suite**

Run:

```powershell
npx vitest run src/lib/reader/__tests__/terminal-format.test.ts src/lib/reader/__tests__/terminal-progress.test.ts src/lib/reader/__tests__/terminal-data.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
npx tsc --noEmit --pretty false
```

Expected: PASS.

- [ ] **Step 3: Run targeted ESLint**

Run:

```powershell
npx eslint scripts/read.ts src/lib/reader/terminal-format.ts src/lib/reader/terminal-progress.ts src/lib/reader/terminal-data.ts src/lib/reader/__tests__/terminal-format.test.ts src/lib/reader/__tests__/terminal-progress.test.ts src/lib/reader/__tests__/terminal-data.test.ts
```

Expected: PASS.

- [ ] **Step 4: Manual Windows Terminal smoke**

Run:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
npm run read -- --book <existing-book-id> --langs auto
```

Verify:

- Header shows book and chapter.
- `1`, `2`, `3`, `4` switch language display modes.
- `n` and `p` move pages.
- `]` and `[` move chapters.
- `q` exits and leaves the terminal usable.
- `data/terminal-progress.json` saves chapter/page/lang mode.

- [ ] **Step 5: Update local handoff files**

Update `AI_TASK_BOARD.md` with a `FEAT-002` row and activity evidence. Update `AI_HANDOFF_SUMMARY.md` and `AI_SESSION_ENTRY.md` if implementation is started or completed.

- [ ] **Step 6: Commit**

Stage only terminal-reader files and taskboard/handoff files:

```powershell
git add package.json scripts/read.ts src/lib/reader/terminal-format.ts src/lib/reader/terminal-progress.ts src/lib/reader/terminal-data.ts src/lib/reader/__tests__/terminal-format.test.ts src/lib/reader/__tests__/terminal-progress.test.ts src/lib/reader/__tests__/terminal-data.test.ts AI_TASK_BOARD.md AI_HANDOFF_SUMMARY.md AI_SESSION_ENTRY.md
git commit -m "feat: add local terminal reader"
```

## Open Questions Before Implementation

1. Progress storage: this plan uses `data/terminal-progress.json`, not DB `reading_progress`, because terminal has no Clerk user. If DB progress sync is required, decide which user id should own terminal progress.
2. Translation trigger: this plan does not auto-trigger missing translations. If terminal should behave like Web reader and start translation jobs, add a separate task after MVP.
3. Rendering HTML: this plan strips HTML. If ruby/furigana or inline emphasis matters in terminal, define a terminal-specific markup convention before implementation.

## Self-Review

- Spec coverage: covers local command, bilingual/trilingual display, keyboard switching, Windows terminal use, local progress, and tests.
- Placeholder scan: no `TBD`/`TODO` placeholders; all tasks have exact file paths and commands.
- Type consistency: `TerminalParagraph`, `TerminalTranslation`, `TerminalProgress`, and helper names are consistent across tests, implementation snippets, and CLI usage.

## Implementation Result

- Implemented on 2026-06-11.
- Added `npm run read`, `npm run read:worker`, `npm run books`, and `scripts/read.ts`.
- Added reader helpers:
  - `src/lib/reader/terminal-cli.ts`
  - `src/lib/reader/terminal-format.ts`
  - `src/lib/reader/terminal-progress.ts`
  - `src/lib/reader/terminal-data.ts`
- Added focused tests under `src/lib/reader/__tests__/`.
- Verification passed:
  - `npx vitest run src/lib/reader/__tests__/terminal-format.test.ts src/lib/reader/__tests__/terminal-progress.test.ts src/lib/reader/__tests__/terminal-data.test.ts src/lib/reader/__tests__/terminal-cli.test.ts` -> 4 files, 23 tests.
  - `npx tsc --noEmit --pretty false`
  - targeted ESLint for reader/CLI files.
  - `npm run read` usage smoke.
  - `npm run read -- --book missing` DB-path smoke.
  - `npm run books` listed `.env.worker` books.
  - `npm run read:worker -- f7ed0fd1-e831-4b80-a1bb-2162a8bd0c31` rendered a real book and wrote DB `reading_progress`.
- Full interactive keyboard smoke in a human Windows Terminal is still pending.
