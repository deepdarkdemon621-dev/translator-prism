# Trilingual EPUB Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal-use trilingual EPUB reader that parses uploaded EPUBs, translates chapters on-demand via LLM, and displays aligned paragraphs in a three-column web reader.

**Architecture:** Next.js 15 full-stack app with React 19 frontend, SQLite database (Drizzle ORM), in-process translation queue (p-queue), and LLM provider abstraction (Claude default). Single Docker container deployment.

**Tech Stack:** Next.js 15, React 19, TypeScript, Tailwind CSS, shadcn/ui, SQLite, Drizzle ORM, JSZip, cheerio, franc, p-queue, Anthropic SDK

**Spec:** `docs/superpowers/specs/2026-04-10-trilingual-epub-reader-design.md`

---

## File Structure

```
translator/
├── src/
│   ├── app/
│   │   ├── layout.tsx                          # Root layout with font imports
│   │   ├── page.tsx                            # Book library page
│   │   ├── read/[bookId]/page.tsx              # Reader page
│   │   ├── settings/page.tsx                   # Settings page
│   │   └── api/
│   │       ├── books/
│   │       │   ├── route.ts                    # GET list
│   │       │   ├── upload/route.ts             # POST upload
│   │       │   └── [id]/route.ts               # GET detail, DELETE
│   │       ├── chapters/[id]/
│   │       │   ├── route.ts                    # GET content
│   │       │   ├── status/route.ts             # GET status
│   │       │   └── translate/route.ts          # POST trigger
│   │       ├── paragraphs/[id]/retry/route.ts  # POST retry
│   │       ├── progress/[bookId]/route.ts      # GET/PUT
│   │       ├── export/[bookId]/
│   │       │   ├── route.ts                    # POST trigger
│   │       │   └── download/route.ts           # GET download
│   │       └── settings/route.ts               # GET/PUT
│   ├── lib/
│   │   ├── db/
│   │   │   ├── index.ts                        # DB connection singleton
│   │   │   ├── schema.ts                       # Drizzle table definitions
│   │   │   └── migrate.ts                      # Migration runner
│   │   ├── epub/
│   │   │   └── parser.ts                       # EPUB unpack + chapter/paragraph extraction
│   │   ├── llm/
│   │   │   ├── types.ts                        # Provider interface
│   │   │   ├── claude.ts                       # Claude provider
│   │   │   └── factory.ts                      # Provider factory
│   │   ├── queue/
│   │   │   └── translation-queue.ts            # p-queue singleton + translate logic
│   │   └── export/
│   │       └── exporter.ts                     # JSON + HTML ZIP export
│   └── components/
│       ├── BookCard.tsx                         # Book card for library
│       ├── UploadZone.tsx                       # Drag-and-drop EPUB upload
│       └── reader/
│           ├── ReaderLayout.tsx                 # Main reader layout orchestrator
│           ├── ColumnView.tsx                   # Single language column
│           ├── ParagraphBlock.tsx               # Single paragraph with highlight
│           ├── ChapterSidebar.tsx               # TOC + translation status
│           ├── TopBar.tsx                       # Book title, mode switch, settings
│           ├── BottomBar.tsx                    # Chapter navigation + progress
│           └── SettingsDrawer.tsx               # Font, size, spacing, theme settings
├── data/                                        # Docker volume (db + uploads + exports)
├── drizzle.config.ts                            # Drizzle config
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── next.config.ts
└── .env.example
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`, `.env.example`, `.gitignore`

- [ ] **Step 1: Initialize Next.js project**

Run:
```bash
cd /c/Programming/translator
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm
```

Select defaults when prompted. This creates the Next.js 15 scaffolding with App Router.

- [ ] **Step 2: Install core dependencies**

Run:
```bash
npm install drizzle-orm better-sqlite3 jszip cheerio franc p-queue@7 @anthropic-ai/sdk uuid archiver
npm install -D drizzle-kit @types/better-sqlite3 @types/uuid @types/archiver vitest
```

- [ ] **Step 3: Install shadcn/ui**

Run:
```bash
npx shadcn@latest init -d
```

Then add components we'll need:

```bash
npx shadcn@latest add button card dialog dropdown-menu input label select separator sheet slider tabs toast scroll-area badge progress
```

- [ ] **Step 4: Create .env.example**

```env
ANTHROPIC_API_KEY=sk-ant-xxx
```

Copy to `.env.local`:
```bash
cp .env.example .env.local
```

- [ ] **Step 5: Create data directories**

```bash
mkdir -p data/uploads data/exports
```

- [ ] **Step 6: Update .gitignore**

Append to the generated `.gitignore`:

```
data/
.env.local
.superpowers/
```

- [ ] **Step 7: Update next.config.ts for server-side packages**

Replace `next.config.ts` content with:

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
```

- [ ] **Step 8: Verify dev server starts**

Run: `npm run dev`
Expected: Server starts on http://localhost:3000 with default Next.js page

- [ ] **Step 9: Commit**

```bash
git init
git add -A
git commit -m "feat: scaffold Next.js project with Tailwind, shadcn/ui, and dependencies"
```

---

## Task 2: Database Schema & Migrations

**Files:**
- Create: `src/lib/db/schema.ts`, `src/lib/db/index.ts`, `src/lib/db/migrate.ts`, `drizzle.config.ts`
- Test: `src/lib/db/__tests__/schema.test.ts`

- [ ] **Step 1: Write schema test**

Create `src/lib/db/__tests__/schema.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

describe("database schema", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeAll(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: "./drizzle" });
  });

  afterAll(() => {
    sqlite.close();
  });

  it("should insert and query a book", () => {
    const bookId = randomUUID();
    db.insert(schema.books).values({
      id: bookId,
      title: "転生したらスライムだった件",
      author: "伏瀬",
      sourceLang: "ja",
      filePath: "/uploads/test.epub",
      totalChapters: 10,
      status: "pending",
    }).run();

    const book = db.select().from(schema.books).where(eq(schema.books.id, bookId)).get();
    expect(book).toBeDefined();
    expect(book!.title).toBe("転生したらスライムだった件");
    expect(book!.sourceLang).toBe("ja");
  });

  it("should insert chapter with book FK", () => {
    const bookId = randomUUID();
    const chapterId = randomUUID();

    db.insert(schema.books).values({
      id: bookId, title: "Test", author: "A", sourceLang: "ja",
      filePath: "/test.epub", totalChapters: 1, status: "parsed",
    }).run();

    db.insert(schema.chapters).values({
      id: chapterId, bookId, index: 0, title: "Chapter 1",
      sourceHtml: "<p>Hello</p>", status: "pending",
    }).run();

    const chapter = db.select().from(schema.chapters).where(eq(schema.chapters.bookId, bookId)).get();
    expect(chapter).toBeDefined();
    expect(chapter!.title).toBe("Chapter 1");
  });

  it("should insert paragraph and translation", () => {
    const bookId = randomUUID();
    const chapterId = randomUUID();
    const paragraphId = randomUUID();
    const translationId = randomUUID();

    db.insert(schema.books).values({
      id: bookId, title: "Test", author: "A", sourceLang: "ja",
      filePath: "/t.epub", totalChapters: 1, status: "parsed",
    }).run();

    db.insert(schema.chapters).values({
      id: chapterId, bookId, index: 0, title: "Ch1",
      sourceHtml: "<p>テスト</p>", status: "done",
    }).run();

    db.insert(schema.paragraphs).values({
      id: paragraphId, chapterId, seq: 0,
      sourceText: "テスト", sourceMarkup: "<p>テスト</p>",
    }).run();

    db.insert(schema.translations).values({
      id: translationId, paragraphId, lang: "zh",
      text: "测试", status: "done", model: "claude-sonnet",
      tokensUsed: 50,
    }).run();

    const translation = db.select().from(schema.translations)
      .where(eq(schema.translations.paragraphId, paragraphId)).get();
    expect(translation).toBeDefined();
    expect(translation!.text).toBe("测试");
    expect(translation!.lang).toBe("zh");
  });

  it("should insert and query reading progress", () => {
    const bookId = randomUUID();
    const progressId = randomUUID();

    db.insert(schema.books).values({
      id: bookId, title: "Test", author: "A", sourceLang: "ja",
      filePath: "/t.epub", totalChapters: 5, status: "parsed",
    }).run();

    db.insert(schema.readingProgress).values({
      id: progressId, bookId, chapterIndex: 2, scrollPosition: 0.45,
    }).run();

    const progress = db.select().from(schema.readingProgress)
      .where(eq(schema.readingProgress.bookId, bookId)).get();
    expect(progress).toBeDefined();
    expect(progress!.chapterIndex).toBe(2);
    expect(progress!.scrollPosition).toBe(0.45);
  });
});
```

- [ ] **Step 2: Add vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
```

Add to `package.json` scripts:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/db/__tests__/schema.test.ts`
Expected: FAIL — schema module not found

- [ ] **Step 4: Write schema**

Create `src/lib/db/schema.ts`:

```typescript
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const books = sqliteTable("books", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  author: text("author").notNull().default("Unknown"),
  sourceLang: text("source_lang").notNull(), // ja | zh | en
  coverPath: text("cover_path"),
  filePath: text("file_path").notNull(),
  totalChapters: integer("total_chapters").notNull().default(0),
  status: text("status").notNull().default("pending"), // pending | parsed | error
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const chapters = sqliteTable("chapters", {
  id: text("id").primaryKey(),
  bookId: text("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  index: integer("index").notNull(),
  title: text("title").notNull(),
  sourceHtml: text("source_html").notNull(),
  status: text("status").notNull().default("pending"), // pending | translating | done | error
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const paragraphs = sqliteTable("paragraphs", {
  id: text("id").primaryKey(),
  chapterId: text("chapter_id").notNull().references(() => chapters.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  sourceText: text("source_text").notNull(),
  sourceMarkup: text("source_markup").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const translations = sqliteTable("translations", {
  id: text("id").primaryKey(),
  paragraphId: text("paragraph_id").notNull().references(() => paragraphs.id, { onDelete: "cascade" }),
  lang: text("lang").notNull(), // zh | en | ja
  text: text("text").notNull().default(""),
  status: text("status").notNull().default("pending"), // pending | processing | done | failed
  model: text("model"),
  tokensUsed: integer("tokens_used"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const readingProgress = sqliteTable("reading_progress", {
  id: text("id").primaryKey(),
  bookId: text("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  chapterIndex: integer("chapter_index").notNull().default(0),
  scrollPosition: real("scroll_position").notNull().default(0),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});
```

- [ ] **Step 5: Write drizzle config**

Create `drizzle.config.ts`:

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "./data/db.sqlite",
  },
});
```

- [ ] **Step 6: Generate migrations**

Run:
```bash
npx drizzle-kit generate
```

Expected: Creates `drizzle/` folder with SQL migration files

- [ ] **Step 7: Write DB connection singleton**

Create `src/lib/db/index.ts`:

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "db.sqlite");

let _db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (!_db) {
    const sqlite = new Database(DB_PATH);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    _db = drizzle(sqlite, { schema });
  }
  return _db;
}
```

- [ ] **Step 8: Write migration runner**

Create `src/lib/db/migrate.ts`:

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "db.sqlite");

export function runMigrations() {
  const sqlite = new Database(DB_PATH);
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  sqlite.close();
}

if (require.main === module) {
  runMigrations();
  console.log("Migrations complete.");
}
```

Add to `package.json` scripts:
```json
"db:migrate": "tsx src/lib/db/migrate.ts"
```

- [ ] **Step 9: Run tests**

Run: `npx vitest run src/lib/db/__tests__/schema.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add database schema with Drizzle ORM and SQLite"
```

---

## Task 3: EPUB Parser

**Files:**
- Create: `src/lib/epub/parser.ts`
- Test: `src/lib/epub/__tests__/parser.test.ts`, `src/lib/epub/__tests__/fixtures/test.epub`

- [ ] **Step 1: Create test EPUB fixture**

Create `src/lib/epub/__tests__/create-fixture.ts`:

```typescript
import JSZip from "jszip";
import fs from "fs";
import path from "path";

async function createTestEpub() {
  const zip = new JSZip();

  zip.file("mimetype", "application/epub+zip");

  zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>テスト小説</dc:title>
    <dc:creator>テスト著者</dc:creator>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="toc">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`);

  zip.file("OEBPS/toc.ncx", `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>第一章 洞窟</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
    <navPoint id="np2" playOrder="2">
      <navLabel><text>第二章 スキル</text></navLabel>
      <content src="chapter2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`);

  zip.file("OEBPS/chapter1.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第一章</title></head>
<body>
  <h1>第一章 洞窟</h1>
  <p>目が覚めると、暗い洞窟の中にいた。</p>
  <p>何も見えない。何も<strong>聞こえない</strong>。</p>
  <p>ただ、意識だけがはっきりとしていた。</p>
</body>
</html>`);

  zip.file("OEBPS/chapter2.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第二章</title></head>
<body>
  <h1>第二章 スキル</h1>
  <p>スキルを獲得した。これは便利だ。</p>
  <p>新しい力を手に入れた気分だ。</p>
</body>
</html>`);

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const outDir = path.join(__dirname, "fixtures");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "test.epub"), buf);
  console.log("Test EPUB created.");
}

createTestEpub();
```

Run:
```bash
npx tsx src/lib/epub/__tests__/create-fixture.ts
```

- [ ] **Step 2: Write parser test**

Create `src/lib/epub/__tests__/parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseEpub } from "../parser";
import path from "path";
import fs from "fs";

const FIXTURE_PATH = path.join(__dirname, "fixtures", "test.epub");

describe("EPUB parser", () => {
  it("should extract book metadata", async () => {
    const buffer = fs.readFileSync(FIXTURE_PATH);
    const result = await parseEpub(buffer);

    expect(result.title).toBe("テスト小説");
    expect(result.author).toBe("テスト著者");
    expect(result.language).toBe("ja");
  });

  it("should extract chapters in spine order", async () => {
    const buffer = fs.readFileSync(FIXTURE_PATH);
    const result = await parseEpub(buffer);

    expect(result.chapters).toHaveLength(2);
    expect(result.chapters[0].title).toBe("第一章 洞窟");
    expect(result.chapters[1].title).toBe("第二章 スキル");
  });

  it("should extract paragraphs from chapter", async () => {
    const buffer = fs.readFileSync(FIXTURE_PATH);
    const result = await parseEpub(buffer);

    const ch1 = result.chapters[0];
    expect(ch1.paragraphs.length).toBe(3);
    expect(ch1.paragraphs[0].text).toBe("目が覚めると、暗い洞窟の中にいた。");
    expect(ch1.paragraphs[1].markup).toContain("<strong>");
  });

  it("should preserve heading as paragraph", async () => {
    const buffer = fs.readFileSync(FIXTURE_PATH);
    const result = await parseEpub(buffer);

    // h1 is not extracted as a paragraph — only <p> tags
    const ch1Texts = result.chapters[0].paragraphs.map((p) => p.text);
    expect(ch1Texts).not.toContain("第一章 洞窟");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/epub/__tests__/parser.test.ts`
Expected: FAIL — parser module not found

- [ ] **Step 4: Implement parser**

Create `src/lib/epub/parser.ts`:

```typescript
import JSZip from "jszip";
import * as cheerio from "cheerio";

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
  coverPath?: string;
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

  // Build manifest map: id -> href
  const manifest = new Map<string, string>();
  $opf("manifest item").each((_, el) => {
    const id = $opf(el).attr("id")!;
    const href = $opf(el).attr("href")!;
    manifest.set(id, href);
  });

  // Spine order
  const spineIds: string[] = [];
  $opf("spine itemref").each((_, el) => {
    spineIds.push($opf(el).attr("idref")!);
  });

  // 3. Try to extract chapter titles from NCX/NAV
  const tocId = $opf("spine").attr("toc");
  const tocTitles = new Map<string, string>();

  if (tocId && manifest.has(tocId)) {
    const tocPath = opfDir + manifest.get(tocId)!;
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
    const href = manifest.get(spineIds[i]);
    if (!href) continue;

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

  return { title, author, language, chapters };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/lib/epub/__tests__/parser.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add EPUB parser with JSZip and cheerio"
```

---

## Task 4: LLM Provider Abstraction

**Files:**
- Create: `src/lib/llm/types.ts`, `src/lib/llm/claude.ts`, `src/lib/llm/factory.ts`
- Test: `src/lib/llm/__tests__/provider.test.ts`

- [ ] **Step 1: Write provider test**

Create `src/lib/llm/__tests__/provider.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ClaudeProvider } from "../claude";
import { createProvider } from "../factory";
import type { LLMProvider, TranslationResult } from "../types";

describe("LLM provider", () => {
  it("ClaudeProvider implements LLMProvider interface", () => {
    const provider = new ClaudeProvider("fake-key");
    expect(provider.name).toBe("claude");
    expect(typeof provider.translate).toBe("function");
  });

  it("createProvider returns ClaudeProvider for 'claude'", () => {
    const provider = createProvider("claude", "fake-key");
    expect(provider.name).toBe("claude");
  });

  it("createProvider throws for unknown provider", () => {
    expect(() => createProvider("unknown", "fake-key")).toThrow("Unknown provider: unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/llm/__tests__/provider.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write types**

Create `src/lib/llm/types.ts`:

```typescript
export interface TranslationResult {
  text: string;
  tokensUsed: number;
  model: string;
}

export interface LLMProvider {
  name: string;
  translate(
    text: string,
    fromLang: string,
    toLang: string,
    model?: string,
  ): Promise<TranslationResult>;
}
```

- [ ] **Step 4: Write Claude provider**

Create `src/lib/llm/claude.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, TranslationResult } from "./types";

const LANG_NAMES: Record<string, string> = {
  ja: "Japanese",
  zh: "Chinese",
  en: "English",
};

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

export class ClaudeProvider implements LLMProvider {
  name = "claude";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async translate(
    text: string,
    fromLang: string,
    toLang: string,
    model?: string,
  ): Promise<TranslationResult> {
    const useModel = model || DEFAULT_MODEL;
    const fromName = LANG_NAMES[fromLang] || fromLang;
    const toName = LANG_NAMES[toLang] || toLang;

    const response = await this.client.messages.create({
      model: useModel,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `Translate the following ${fromName} novel text into ${toName}. Maintain the literary style, tone, and nuance of the original. Return ONLY the translated text, nothing else.\n\n${text}`,
        },
      ],
    });

    const content = response.content[0];
    const translatedText = content.type === "text" ? content.text : "";
    const tokensUsed =
      (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

    return {
      text: translatedText,
      tokensUsed,
      model: useModel,
    };
  }
}
```

- [ ] **Step 5: Write factory**

Create `src/lib/llm/factory.ts`:

```typescript
import type { LLMProvider } from "./types";
import { ClaudeProvider } from "./claude";

export function createProvider(name: string, apiKey: string): LLMProvider {
  switch (name) {
    case "claude":
      return new ClaudeProvider(apiKey);
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/lib/llm/__tests__/provider.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add LLM provider abstraction with Claude implementation"
```

---

## Task 5: Translation Queue

**Files:**
- Create: `src/lib/queue/translation-queue.ts`
- Test: `src/lib/queue/__tests__/translation-queue.test.ts`

- [ ] **Step 1: Write queue test**

Create `src/lib/queue/__tests__/translation-queue.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TranslationQueue } from "../translation-queue";
import type { LLMProvider, TranslationResult } from "../../llm/types";

function createMockProvider(): LLMProvider {
  return {
    name: "mock",
    translate: vi.fn().mockResolvedValue({
      text: "translated text",
      tokensUsed: 100,
      model: "mock-model",
    } satisfies TranslationResult),
  };
}

describe("TranslationQueue", () => {
  it("should process a translation job", async () => {
    const provider = createMockProvider();
    const queue = new TranslationQueue(provider, { concurrency: 1 });
    const onComplete = vi.fn();

    queue.add({
      translationId: "t1",
      text: "テスト",
      fromLang: "ja",
      toLang: "zh",
      onComplete,
      onError: vi.fn(),
    });

    await queue.onIdle();

    expect(provider.translate).toHaveBeenCalledWith("テスト", "ja", "zh", undefined);
    expect(onComplete).toHaveBeenCalledWith({
      text: "translated text",
      tokensUsed: 100,
      model: "mock-model",
    });
  });

  it("should call onError when translation fails", async () => {
    const provider = createMockProvider();
    (provider.translate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API error"));

    const queue = new TranslationQueue(provider, { concurrency: 1 });
    const onError = vi.fn();

    queue.add({
      translationId: "t2",
      text: "テスト",
      fromLang: "ja",
      toLang: "en",
      onComplete: vi.fn(),
      onError,
    });

    await queue.onIdle();

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("should respect concurrency limit", async () => {
    const provider = createMockProvider();
    let concurrent = 0;
    let maxConcurrent = 0;

    (provider.translate as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 50));
      concurrent--;
      return { text: "ok", tokensUsed: 10, model: "m" };
    });

    const queue = new TranslationQueue(provider, { concurrency: 2 });

    for (let i = 0; i < 6; i++) {
      queue.add({
        translationId: `t${i}`,
        text: "テスト",
        fromLang: "ja",
        toLang: "zh",
        onComplete: vi.fn(),
        onError: vi.fn(),
      });
    }

    await queue.onIdle();

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/queue/__tests__/translation-queue.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement translation queue**

Create `src/lib/queue/translation-queue.ts`:

```typescript
import type { LLMProvider, TranslationResult } from "../llm/types";

export interface TranslationJob {
  translationId: string;
  text: string;
  fromLang: string;
  toLang: string;
  model?: string;
  onComplete: (result: TranslationResult) => void;
  onError: (error: Error) => void;
}

export class TranslationQueue {
  private provider: LLMProvider;
  private queue: TranslationJob[] = [];
  private running = 0;
  private concurrency: number;
  private idleResolvers: (() => void)[] = [];

  constructor(provider: LLMProvider, options: { concurrency: number } = { concurrency: 2 }) {
    this.provider = provider;
    this.concurrency = options.concurrency;
  }

  add(job: TranslationJob): void {
    this.queue.push(job);
    this.processNext();
  }

  get pending(): number {
    return this.queue.length;
  }

  get activeCount(): number {
    return this.running;
  }

  async onIdle(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return;
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  updateProvider(provider: LLMProvider): void {
    this.provider = provider;
  }

  private async processNext(): Promise<void> {
    if (this.running >= this.concurrency || this.queue.length === 0) return;

    const job = this.queue.shift()!;
    this.running++;

    try {
      const result = await this.provider.translate(job.text, job.fromLang, job.toLang, job.model);
      job.onComplete(result);
    } catch (err) {
      job.onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.running--;
      this.processNext();
      if (this.running === 0 && this.queue.length === 0) {
        this.idleResolvers.forEach((r) => r());
        this.idleResolvers = [];
      }
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/queue/__tests__/translation-queue.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add translation queue with p-queue-style concurrency control"
```

---

## Task 6: API Routes — Books

**Files:**
- Create: `src/app/api/books/route.ts`, `src/app/api/books/upload/route.ts`, `src/app/api/books/[id]/route.ts`

- [ ] **Step 1: Write books list + upload routes**

Create `src/app/api/books/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, chapters } from "@/lib/db/schema";
import { desc, eq, count } from "drizzle-orm";

export async function GET() {
  const db = getDb();

  const allBooks = db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      sourceLang: books.sourceLang,
      coverPath: books.coverPath,
      totalChapters: books.totalChapters,
      status: books.status,
      createdAt: books.createdAt,
    })
    .from(books)
    .orderBy(desc(books.createdAt))
    .all();

  // Get translated chapter counts
  const booksWithProgress = allBooks.map((book) => {
    const doneChapters = db
      .select({ count: count() })
      .from(chapters)
      .where(eq(chapters.bookId, book.id))
      .all();

    const translatedCount = db
      .select({ count: count() })
      .from(chapters)
      .where(eq(chapters.bookId, book.id))
      .all();

    return {
      ...book,
      translatedChapters: translatedCount[0]?.count || 0,
    };
  });

  return NextResponse.json(booksWithProgress);
}
```

Create `src/app/api/books/upload/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, chapters, paragraphs } from "@/lib/db/schema";
import { parseEpub } from "@/lib/epub/parser";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";

const UPLOAD_DIR = path.join(process.cwd(), "data", "uploads");
const MAX_SIZE = 50 * 1024 * 1024; // 50MB

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "File too large (max 50MB)" }, { status: 400 });
  }

  if (!file.name.endsWith(".epub")) {
    return NextResponse.json({ error: "Only EPUB files are supported" }, { status: 400 });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());

    // Save file
    const bookId = randomUUID();
    const fileName = `${bookId}.epub`;
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const filePath = path.join(UPLOAD_DIR, fileName);
    await fs.writeFile(filePath, buffer);

    // Parse EPUB
    const parsed = await parseEpub(buffer);

    const db = getDb();

    // Insert book
    db.insert(books)
      .values({
        id: bookId,
        title: parsed.title,
        author: parsed.author,
        sourceLang: parsed.language.substring(0, 2).toLowerCase(),
        filePath: fileName,
        totalChapters: parsed.chapters.length,
        status: "parsed",
      })
      .run();

    // Insert all chapters and first chapter's paragraphs
    for (let i = 0; i < parsed.chapters.length; i++) {
      const ch = parsed.chapters[i];
      const chapterId = randomUUID();

      db.insert(chapters)
        .values({
          id: chapterId,
          bookId,
          index: i,
          title: ch.title,
          sourceHtml: ch.sourceHtml,
          status: "pending",
        })
        .run();

      // Only parse paragraphs for first chapter immediately
      if (i === 0) {
        for (let j = 0; j < ch.paragraphs.length; j++) {
          db.insert(paragraphs)
            .values({
              id: randomUUID(),
              chapterId,
              seq: j,
              sourceText: ch.paragraphs[j].text,
              sourceMarkup: ch.paragraphs[j].markup,
            })
            .run();
        }
      }
    }

    return NextResponse.json({
      id: bookId,
      title: parsed.title,
      author: parsed.author,
      sourceLang: parsed.language,
      totalChapters: parsed.chapters.length,
    });
  } catch (err) {
    console.error("Upload error:", err);
    return NextResponse.json(
      { error: "Failed to parse EPUB" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Write book detail + delete route**

Create `src/app/api/books/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, chapters } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import fs from "fs/promises";
import path from "path";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  const book = db.select().from(books).where(eq(books.id, id)).get();
  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const chapterList = db
    .select({
      id: chapters.id,
      index: chapters.index,
      title: chapters.title,
      status: chapters.status,
    })
    .from(chapters)
    .where(eq(chapters.bookId, id))
    .orderBy(chapters.index)
    .all();

  return NextResponse.json({ ...book, chapters: chapterList });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  const book = db.select().from(books).where(eq(books.id, id)).get();
  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  // Delete file
  try {
    const filePath = path.join(process.cwd(), "data", "uploads", book.filePath);
    await fs.unlink(filePath);
  } catch {
    // File may already be deleted
  }

  // Cascade delete handles chapters, paragraphs, translations
  db.delete(books).where(eq(books.id, id)).run();

  return NextResponse.json({ success: true });
}
```

- [ ] **Step 3: Verify routes compile**

Run: `npm run build`
Expected: Build succeeds (or `npm run dev` and test manually)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add book API routes (list, upload, detail, delete)"
```

---

## Task 7: API Routes — Chapters & Translation

**Files:**
- Create: `src/app/api/chapters/[id]/route.ts`, `src/app/api/chapters/[id]/status/route.ts`, `src/app/api/chapters/[id]/translate/route.ts`, `src/app/api/paragraphs/[id]/retry/route.ts`

- [ ] **Step 1: Write chapter content route**

Create `src/app/api/chapters/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { chapters, paragraphs, translations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  const chapter = db.select().from(chapters).where(eq(chapters.id, id)).get();
  if (!chapter) {
    return NextResponse.json({ error: "Chapter not found" }, { status: 404 });
  }

  const paras = db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, id))
    .orderBy(paragraphs.seq)
    .all();

  const parasWithTranslations = paras.map((p) => {
    const trans = db
      .select()
      .from(translations)
      .where(eq(translations.paragraphId, p.id))
      .all();

    return {
      ...p,
      translations: trans.reduce(
        (acc, t) => {
          acc[t.lang] = { text: t.text, status: t.status };
          return acc;
        },
        {} as Record<string, { text: string; status: string }>,
      ),
    };
  });

  return NextResponse.json({
    ...chapter,
    paragraphs: parasWithTranslations,
  });
}
```

- [ ] **Step 2: Write chapter status route**

Create `src/app/api/chapters/[id]/status/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { chapters, paragraphs, translations } from "@/lib/db/schema";
import { eq, count, and } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  const chapter = db
    .select({ status: chapters.status })
    .from(chapters)
    .where(eq(chapters.id, id))
    .get();

  if (!chapter) {
    return NextResponse.json({ error: "Chapter not found" }, { status: 404 });
  }

  const totalParas = db
    .select({ count: count() })
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, id))
    .get();

  const doneTranslations = db
    .select({ count: count() })
    .from(translations)
    .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
    .where(and(eq(paragraphs.chapterId, id), eq(translations.status, "done")))
    .get();

  const failedTranslations = db
    .select({ count: count() })
    .from(translations)
    .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
    .where(and(eq(paragraphs.chapterId, id), eq(translations.status, "failed")))
    .get();

  return NextResponse.json({
    chapterStatus: chapter.status,
    totalParagraphs: totalParas?.count || 0,
    doneTranslations: doneTranslations?.count || 0,
    failedTranslations: failedTranslations?.count || 0,
  });
}
```

- [ ] **Step 3: Write translate trigger route**

Create `src/app/api/chapters/[id]/translate/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, chapters, paragraphs, translations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { parseEpub } from "@/lib/epub/parser";
import { getTranslationQueue } from "@/lib/queue/translation-queue";
import { randomUUID } from "crypto";

const TARGET_LANGS: Record<string, string[]> = {
  ja: ["zh", "en"],
  zh: ["ja", "en"],
  en: ["ja", "zh"],
};

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  const chapter = db.select().from(chapters).where(eq(chapters.id, id)).get();
  if (!chapter) {
    return NextResponse.json({ error: "Chapter not found" }, { status: 404 });
  }

  const book = db.select().from(books).where(eq(books.id, chapter.bookId)).get();
  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  // Parse paragraphs if not already done
  let paras = db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, id))
    .orderBy(paragraphs.seq)
    .all();

  if (paras.length === 0) {
    // Re-parse chapter from source HTML
    const $ = await import("cheerio").then((m) => m.load(chapter.sourceHtml, { xmlMode: true }));
    const extracted: { text: string; markup: string }[] = [];
    $("body p, p").each((_, el) => {
      const text = $(el).text().trim();
      if (text.length === 0) return;
      const markup = $.html(el) || "";
      extracted.push({ text, markup });
    });

    for (let j = 0; j < extracted.length; j++) {
      db.insert(paragraphs)
        .values({
          id: randomUUID(),
          chapterId: id,
          seq: j,
          sourceText: extracted[j].text,
          sourceMarkup: extracted[j].markup,
        })
        .run();
    }

    paras = db
      .select()
      .from(paragraphs)
      .where(eq(paragraphs.chapterId, id))
      .orderBy(paragraphs.seq)
      .all();
  }

  // Create translation records and queue jobs
  const sourceLang = book.sourceLang;
  const targetLangs = TARGET_LANGS[sourceLang] || ["zh", "en"];
  const queue = getTranslationQueue();

  let queued = 0;
  for (const para of paras) {
    for (const lang of targetLangs) {
      // Check if translation already exists and is done
      const existing = db
        .select()
        .from(translations)
        .where(eq(translations.paragraphId, para.id))
        .all()
        .find((t) => t.lang === lang);

      if (existing && existing.status === "done") continue;

      const translationId = existing?.id || randomUUID();

      if (!existing) {
        db.insert(translations)
          .values({
            id: translationId,
            paragraphId: para.id,
            lang,
            status: "pending",
          })
          .run();
      } else {
        db.update(translations)
          .set({ status: "pending", errorMessage: null, updatedAt: new Date().toISOString() })
          .where(eq(translations.id, translationId))
          .run();
      }

      queue.add({
        translationId,
        text: para.sourceText,
        fromLang: sourceLang,
        toLang: lang,
        onComplete: (result) => {
          db.update(translations)
            .set({
              text: result.text,
              status: "done",
              model: result.model,
              tokensUsed: result.tokensUsed,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(translations.id, translationId))
            .run();

          // Check if chapter is fully done
          checkChapterDone(id);
        },
        onError: (error) => {
          db.update(translations)
            .set({
              status: "failed",
              errorMessage: error.message,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(translations.id, translationId))
            .run();
        },
      });

      queued++;
    }
  }

  // Update chapter status
  db.update(chapters)
    .set({ status: "translating", updatedAt: new Date().toISOString() })
    .where(eq(chapters.id, id))
    .run();

  return NextResponse.json({ queued, totalParagraphs: paras.length });
}

function checkChapterDone(chapterId: string) {
  const db = getDb();
  const paras = db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, chapterId))
    .all();

  const allTranslations = paras.flatMap((p) =>
    db.select().from(translations).where(eq(translations.paragraphId, p.id)).all(),
  );

  const allDone = allTranslations.length > 0 && allTranslations.every((t) => t.status === "done");
  const anyFailed = allTranslations.some((t) => t.status === "failed");

  if (allDone) {
    db.update(chapters)
      .set({ status: "done", updatedAt: new Date().toISOString() })
      .where(eq(chapters.id, chapterId))
      .run();
  } else if (anyFailed && !allTranslations.some((t) => t.status === "pending" || t.status === "processing")) {
    db.update(chapters)
      .set({ status: "error", updatedAt: new Date().toISOString() })
      .where(eq(chapters.id, chapterId))
      .run();
  }
}
```

- [ ] **Step 4: Write paragraph retry route**

Create `src/app/api/paragraphs/[id]/retry/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { translations, paragraphs, chapters, books } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getTranslationQueue } from "@/lib/queue/translation-queue";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  const failedTranslations = db
    .select()
    .from(translations)
    .where(eq(translations.paragraphId, id))
    .all()
    .filter((t) => t.status === "failed");

  if (failedTranslations.length === 0) {
    return NextResponse.json({ error: "No failed translations" }, { status: 400 });
  }

  const para = db.select().from(paragraphs).where(eq(paragraphs.id, id)).get();
  if (!para) {
    return NextResponse.json({ error: "Paragraph not found" }, { status: 404 });
  }

  const chapter = db.select().from(chapters).where(eq(chapters.id, para.chapterId)).get();
  const book = db.select().from(books).where(eq(books.id, chapter!.bookId)).get();
  const queue = getTranslationQueue();

  for (const t of failedTranslations) {
    db.update(translations)
      .set({ status: "pending", errorMessage: null, updatedAt: new Date().toISOString() })
      .where(eq(translations.id, t.id))
      .run();

    queue.add({
      translationId: t.id,
      text: para.sourceText,
      fromLang: book!.sourceLang,
      toLang: t.lang,
      onComplete: (result) => {
        db.update(translations)
          .set({
            text: result.text,
            status: "done",
            model: result.model,
            tokensUsed: result.tokensUsed,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(translations.id, t.id))
          .run();
      },
      onError: (error) => {
        db.update(translations)
          .set({
            status: "failed",
            errorMessage: error.message,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(translations.id, t.id))
          .run();
      },
    });
  }

  return NextResponse.json({ retried: failedTranslations.length });
}
```

- [ ] **Step 5: Update translation-queue.ts to be a singleton**

Add to the end of `src/lib/queue/translation-queue.ts`:

```typescript
import { createProvider } from "../llm/factory";

let _queue: TranslationQueue | null = null;

export function getTranslationQueue(): TranslationQueue {
  if (!_queue) {
    const apiKey = process.env.ANTHROPIC_API_KEY || "";
    const provider = createProvider("claude", apiKey);
    _queue = new TranslationQueue(provider, { concurrency: 2 });
  }
  return _queue;
}
```

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add chapter translation API with queue integration"
```

---

## Task 8: API Routes — Progress, Settings, Export

**Files:**
- Create: `src/app/api/progress/[bookId]/route.ts`, `src/app/api/settings/route.ts`, `src/app/api/export/[bookId]/route.ts`, `src/app/api/export/[bookId]/download/route.ts`, `src/lib/export/exporter.ts`

- [ ] **Step 1: Write progress route**

Create `src/app/api/progress/[bookId]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { readingProgress } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params;
  const db = getDb();

  const progress = db
    .select()
    .from(readingProgress)
    .where(eq(readingProgress.bookId, bookId))
    .get();

  return NextResponse.json(progress || { chapterIndex: 0, scrollPosition: 0 });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params;
  const body = await request.json();
  const db = getDb();

  const existing = db
    .select()
    .from(readingProgress)
    .where(eq(readingProgress.bookId, bookId))
    .get();

  if (existing) {
    db.update(readingProgress)
      .set({
        chapterIndex: body.chapterIndex ?? existing.chapterIndex,
        scrollPosition: body.scrollPosition ?? existing.scrollPosition,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(readingProgress.bookId, bookId))
      .run();
  } else {
    db.insert(readingProgress)
      .values({
        id: randomUUID(),
        bookId,
        chapterIndex: body.chapterIndex ?? 0,
        scrollPosition: body.scrollPosition ?? 0,
      })
      .run();
  }

  return NextResponse.json({ success: true });
}
```

- [ ] **Step 2: Write settings route**

Create `src/app/api/settings/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

const SETTINGS_PATH = path.join(process.cwd(), "data", "settings.json");

const DEFAULT_SETTINGS = {
  llm: {
    provider: "claude",
    model: "claude-sonnet-4-20250514",
    apiKey: "",
    concurrency: 2,
  },
  reading: {
    theme: "dark",
    fontSize: 16,
    lineHeight: 1.8,
    paragraphSpacing: "standard",
    fonts: {
      ja: "Noto Serif JP",
      zh: "Noto Serif SC",
      en: "Georgia",
    },
  },
};

async function loadSettings() {
  try {
    const data = await fs.readFile(SETTINGS_PATH, "utf-8");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function GET() {
  const settings = await loadSettings();
  // Don't expose API key fully
  return NextResponse.json({
    ...settings,
    llm: {
      ...settings.llm,
      apiKey: settings.llm.apiKey ? "***configured***" : "",
    },
  });
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  const current = await loadSettings();
  const merged = {
    ...current,
    ...body,
    llm: { ...current.llm, ...body.llm },
    reading: { ...current.reading, ...body.reading, fonts: { ...current.reading.fonts, ...body.reading?.fonts } },
  };

  await fs.writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return NextResponse.json({ success: true });
}
```

- [ ] **Step 3: Write exporter**

Create `src/lib/export/exporter.ts`:

```typescript
import { getDb } from "@/lib/db";
import { books, chapters, paragraphs, translations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import archiver from "archiver";
import fs from "fs";
import path from "path";

const EXPORT_DIR = path.join(process.cwd(), "data", "exports");

const LANG_LABELS: Record<string, string> = {
  ja: "日本語",
  zh: "中文",
  en: "English",
};

export async function exportJson(bookId: string): Promise<string> {
  const db = getDb();
  const book = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book) throw new Error("Book not found");

  const chapterList = db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(chapters.index)
    .all();

  const data = {
    book: { title: book.title, author: book.author, sourceLang: book.sourceLang },
    chapters: chapterList.map((ch) => {
      const paras = db
        .select()
        .from(paragraphs)
        .where(eq(paragraphs.chapterId, ch.id))
        .orderBy(paragraphs.seq)
        .all();

      return {
        index: ch.index,
        title: ch.title,
        paragraphs: paras.map((p) => {
          const trans = db
            .select()
            .from(translations)
            .where(eq(translations.paragraphId, p.id))
            .all();

          return {
            seq: p.seq,
            source: p.sourceText,
            translations: Object.fromEntries(trans.filter((t) => t.status === "done").map((t) => [t.lang, t.text])),
          };
        }),
      };
    }),
  };

  await fs.promises.mkdir(EXPORT_DIR, { recursive: true });
  const fileName = `${bookId}.json`;
  const filePath = path.join(EXPORT_DIR, fileName);
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
  return fileName;
}

export async function exportHtmlZip(bookId: string): Promise<string> {
  const db = getDb();
  const book = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book) throw new Error("Book not found");

  await fs.promises.mkdir(EXPORT_DIR, { recursive: true });
  const fileName = `${bookId}.zip`;
  const filePath = path.join(EXPORT_DIR, fileName);

  const output = fs.createWriteStream(filePath);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.pipe(output);

  const chapterList = db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(chapters.index)
    .all();

  const sourceLang = book.sourceLang;
  const allLangs = ["ja", "zh", "en"];

  // CSS
  archive.append(
    `body{font-family:Georgia,'Noto Serif SC','Noto Serif JP',serif;max-width:1200px;margin:0 auto;padding:20px;background:#1a1a2e;color:#e0e0e0;}
.columns{display:flex;gap:20px;}.col{flex:1;}.col h3{text-align:center;color:#888;font-size:12px;text-transform:uppercase;}
p{line-height:1.8;margin:0 0 16px;padding:8px;border-radius:4px;}
a{color:#e94560;text-decoration:none;}a:hover{text-decoration:underline;}
h1{text-align:center;color:#e94560;}h2{color:#ccc;}`,
    { name: "style.css" },
  );

  // Index page
  let indexHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${book.title}</title><link rel="stylesheet" href="style.css"></head><body>
<h1>${book.title}</h1><p style="text-align:center;color:#888">${book.author}</p><h2>目录</h2><ul>`;

  for (const ch of chapterList) {
    const chFileName = `chapter-${String(ch.index + 1).padStart(2, "0")}.html`;
    indexHtml += `<li><a href="${chFileName}">${ch.title}</a></li>`;

    // Chapter page
    const paras = db.select().from(paragraphs).where(eq(paragraphs.chapterId, ch.id)).orderBy(paragraphs.seq).all();

    let chHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ch.title}</title><link rel="stylesheet" href="style.css"></head><body>
<p><a href="index.html">← 目录</a></p><h1>${ch.title}</h1><div class="columns">`;

    for (const lang of allLangs) {
      chHtml += `<div class="col"><h3>${LANG_LABELS[lang] || lang}</h3>`;
      for (const p of paras) {
        if (lang === sourceLang) {
          chHtml += `<p>${p.sourceText}</p>`;
        } else {
          const t = db.select().from(translations).where(eq(translations.paragraphId, p.id)).all().find((tr) => tr.lang === lang && tr.status === "done");
          chHtml += `<p>${t?.text || "<em>未翻译</em>"}</p>`;
        }
      }
      chHtml += "</div>";
    }

    chHtml += "</div></body></html>";
    archive.append(chHtml, { name: chFileName });
  }

  indexHtml += "</ul></body></html>";
  archive.append(indexHtml, { name: "index.html" });

  await archive.finalize();
  await new Promise<void>((resolve) => output.on("close", resolve));

  return fileName;
}
```

- [ ] **Step 4: Write export routes**

Create `src/app/api/export/[bookId]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { exportJson, exportHtmlZip } from "@/lib/export/exporter";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params;
  const body = await request.json();
  const format = body.format || "json";

  try {
    const fileName = format === "html" ? await exportHtmlZip(bookId) : await exportJson(bookId);
    return NextResponse.json({ fileName, format });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
```

Create `src/app/api/export/[bookId]/download/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

const EXPORT_DIR = path.join(process.cwd(), "data", "exports");

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params;
  const url = new URL(request.url);
  const fileName = url.searchParams.get("file");

  if (!fileName) {
    return NextResponse.json({ error: "Missing file parameter" }, { status: 400 });
  }

  // Prevent path traversal
  const safeName = path.basename(fileName);
  const filePath = path.join(EXPORT_DIR, safeName);

  try {
    const data = await fs.readFile(filePath);
    const contentType = safeName.endsWith(".zip") ? "application/zip" : "application/json";
    return new NextResponse(data, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${safeName}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add progress, settings, and export API routes"
```

---

## Task 9: Frontend — Layout & Book Library

**Files:**
- Create: `src/app/layout.tsx` (modify), `src/app/page.tsx` (rewrite), `src/components/BookCard.tsx`, `src/components/UploadZone.tsx`

- [ ] **Step 1: Update root layout**

Replace `src/app/layout.tsx`:

```typescript
import type { Metadata } from "next";
import { Noto_Serif_JP, Noto_Serif_SC } from "next/font/google";
import "./globals.css";

const notoJp = Noto_Serif_JP({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-noto-jp",
  display: "swap",
});

const notoSc = Noto_Serif_SC({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-noto-sc",
  display: "swap",
});

export const metadata: Metadata = {
  title: "三語リーダー — Trilingual Reader",
  description: "Trilingual EPUB novel reader with AI translation",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" className="dark">
      <body className={`${notoJp.variable} ${notoSc.variable} antialiased bg-background text-foreground`}>
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Write UploadZone component**

Create `src/components/UploadZone.tsx`:

```typescript
"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";

interface UploadZoneProps {
  onUploadComplete: () => void;
}

export function UploadZone({ onUploadComplete }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = useCallback(
    async (file: File) => {
      if (!file.name.endsWith(".epub")) {
        setError("Only EPUB files are supported");
        return;
      }

      setIsUploading(true);
      setError(null);

      try {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch("/api/books/upload", {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Upload failed");
        }

        onUploadComplete();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setIsUploading(false);
      }
    },
    [onUploadComplete],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleUpload(file);
    },
    [handleUpload],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleUpload(file);
    },
    [handleUpload],
  );

  return (
    <div
      className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
        isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      {isUploading ? (
        <p className="text-muted-foreground">Uploading and parsing...</p>
      ) : (
        <>
          <p className="text-muted-foreground mb-4">
            Drag and drop an EPUB file here, or click to select
          </p>
          <label>
            <Button variant="outline" asChild>
              <span>Select EPUB</span>
            </Button>
            <input
              type="file"
              accept=".epub"
              className="hidden"
              onChange={handleFileSelect}
            />
          </label>
        </>
      )}
      {error && <p className="text-destructive mt-2 text-sm">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Write BookCard component**

Create `src/components/BookCard.tsx`:

```typescript
"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import Link from "next/link";

interface BookCardProps {
  book: {
    id: string;
    title: string;
    author: string;
    sourceLang: string;
    totalChapters: number;
    translatedChapters: number;
    status: string;
  };
  onDelete: (id: string) => void;
}

const LANG_LABELS: Record<string, string> = {
  ja: "日本語",
  zh: "中文",
  en: "English",
};

export function BookCard({ book, onDelete }: BookCardProps) {
  const progress =
    book.totalChapters > 0
      ? Math.round((book.translatedChapters / book.totalChapters) * 100)
      : 0;

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-2">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold truncate">{book.title}</h3>
            <p className="text-sm text-muted-foreground">{book.author}</p>
          </div>
          <Badge variant="secondary" className="ml-2 shrink-0">
            {LANG_LABELS[book.sourceLang] || book.sourceLang}
          </Badge>
        </div>

        <div className="mb-3">
          <div className="flex justify-between text-xs text-muted-foreground mb-1">
            <span>Translation progress</span>
            <span>
              {book.translatedChapters} / {book.totalChapters} chapters
            </span>
          </div>
          <Progress value={progress} className="h-1.5" />
        </div>

        <div className="flex gap-2">
          <Button asChild size="sm" className="flex-1">
            <Link href={`/read/${book.id}`}>Read</Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (confirm("Delete this book and all translations?")) {
                onDelete(book.id);
              }
            }}
          >
            Delete
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Write book library page**

Replace `src/app/page.tsx`:

```typescript
"use client";

import { useCallback, useEffect, useState } from "react";
import { UploadZone } from "@/components/UploadZone";
import { BookCard } from "@/components/BookCard";

interface Book {
  id: string;
  title: string;
  author: string;
  sourceLang: string;
  totalChapters: number;
  translatedChapters: number;
  status: string;
}

export default function HomePage() {
  const [books, setBooks] = useState<Book[]>([]);

  const fetchBooks = useCallback(async () => {
    const res = await fetch("/api/books");
    if (res.ok) {
      setBooks(await res.json());
    }
  }, []);

  useEffect(() => {
    fetchBooks();
  }, [fetchBooks]);

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/books/${id}`, { method: "DELETE" });
    if (res.ok) fetchBooks();
  };

  return (
    <div className="min-h-screen p-6 max-w-5xl mx-auto">
      <header className="mb-8">
        <h1 className="text-2xl font-bold">三語リーダー</h1>
        <p className="text-muted-foreground">Trilingual EPUB Reader</p>
      </header>

      <section className="mb-8">
        <UploadZone onUploadComplete={fetchBooks} />
      </section>

      {books.length > 0 ? (
        <section>
          <h2 className="text-lg font-semibold mb-4">Library</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {books.map((book) => (
              <BookCard key={book.id} book={book} onDelete={handleDelete} />
            ))}
          </div>
        </section>
      ) : (
        <p className="text-center text-muted-foreground py-12">
          Upload an EPUB to get started
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Initialize database on startup**

Create `src/lib/db/init.ts`:

```typescript
import { existsSync, mkdirSync } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

export function ensureDataDir() {
  for (const dir of [DATA_DIR, path.join(DATA_DIR, "uploads"), path.join(DATA_DIR, "exports")]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
```

Add to `src/app/api/books/route.ts` and `src/app/api/books/upload/route.ts` at the top of each handler (before `getDb()`):

```typescript
import { ensureDataDir } from "@/lib/db/init";
// ... at start of handler:
ensureDataDir();
```

- [ ] **Step 6: Verify dev server and UI**

Run: `npm run dev`
Open http://localhost:3000
Expected: Book library page shows with upload zone and empty state

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add book library page with upload and card list"
```

---

## Task 10: Frontend — Reader Layout

**Files:**
- Create: `src/app/read/[bookId]/page.tsx`, `src/components/reader/ReaderLayout.tsx`, `src/components/reader/TopBar.tsx`, `src/components/reader/BottomBar.tsx`, `src/components/reader/ChapterSidebar.tsx`, `src/components/reader/ColumnView.tsx`, `src/components/reader/ParagraphBlock.tsx`

- [ ] **Step 1: Write ParagraphBlock component**

Create `src/components/reader/ParagraphBlock.tsx`:

```typescript
"use client";

interface ParagraphBlockProps {
  id: string;
  text: string;
  isHighlighted: boolean;
  onClick: (id: string) => void;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  status?: string;
}

export function ParagraphBlock({
  id,
  text,
  isHighlighted,
  onClick,
  fontSize,
  lineHeight,
  fontFamily,
  status,
}: ParagraphBlockProps) {
  return (
    <p
      className={`px-3 py-2 rounded cursor-pointer transition-colors ${
        isHighlighted
          ? "bg-primary/10 border-l-[3px] border-primary"
          : "hover:bg-muted/50"
      } ${status === "processing" || status === "pending" ? "opacity-50" : ""}`}
      style={{ fontSize: `${fontSize}px`, lineHeight, fontFamily }}
      onClick={() => onClick(id)}
    >
      {status === "processing" || status === "pending" ? (
        <span className="text-muted-foreground italic">Translating...</span>
      ) : (
        text
      )}
    </p>
  );
}
```

- [ ] **Step 2: Write ColumnView component**

Create `src/components/reader/ColumnView.tsx`:

```typescript
"use client";

import { ParagraphBlock } from "./ParagraphBlock";

interface Paragraph {
  id: string;
  seq: number;
  sourceText: string;
  translations: Record<string, { text: string; status: string }>;
}

interface ColumnViewProps {
  lang: string;
  label: string;
  sourceLang: string;
  paragraphs: Paragraph[];
  highlightedId: string | null;
  onParagraphClick: (id: string) => void;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
}

export function ColumnView({
  lang,
  label,
  sourceLang,
  paragraphs,
  highlightedId,
  onParagraphClick,
  fontSize,
  lineHeight,
  fontFamily,
}: ColumnViewProps) {
  return (
    <div className="flex-1 px-5 py-4 overflow-y-auto">
      <div className="text-center text-xs text-muted-foreground uppercase mb-3 font-sans">
        {label}
      </div>
      <div className="space-y-0">
        {paragraphs.map((p) => {
          const isSource = lang === sourceLang;
          const text = isSource
            ? p.sourceText
            : p.translations[lang]?.text || "";
          const status = isSource ? "done" : p.translations[lang]?.status;

          return (
            <ParagraphBlock
              key={p.id}
              id={p.id}
              text={text}
              isHighlighted={highlightedId === p.id}
              onClick={onParagraphClick}
              fontSize={fontSize}
              lineHeight={lineHeight}
              fontFamily={fontFamily}
              status={status}
            />
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write ChapterSidebar**

Create `src/components/reader/ChapterSidebar.tsx`:

```typescript
"use client";

import { ScrollArea } from "@/components/ui/scroll-area";

interface Chapter {
  id: string;
  index: number;
  title: string;
  status: string;
}

interface ChapterSidebarProps {
  chapters: Chapter[];
  currentIndex: number;
  onSelect: (index: number) => void;
  isOpen: boolean;
}

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  done: { icon: "●", color: "text-green-400" },
  translating: { icon: "◐", color: "text-yellow-400" },
  pending: { icon: "○", color: "text-muted-foreground" },
  error: { icon: "✕", color: "text-destructive" },
};

export function ChapterSidebar({
  chapters,
  currentIndex,
  onSelect,
  isOpen,
}: ChapterSidebarProps) {
  if (!isOpen) return null;

  return (
    <div className="w-48 border-r border-border bg-muted/30 flex-shrink-0">
      <ScrollArea className="h-full p-3">
        <div className="text-xs text-muted-foreground uppercase mb-2 font-sans">
          Table of Contents
        </div>
        {chapters.map((ch) => {
          const isCurrent = ch.index === currentIndex;
          const statusInfo = STATUS_ICONS[ch.status] || STATUS_ICONS.pending;

          return (
            <button
              key={ch.id}
              className={`block w-full text-left text-sm py-1.5 px-1 rounded transition-colors ${
                isCurrent
                  ? "text-primary font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => onSelect(ch.index)}
            >
              <span className={`${statusInfo.color} mr-1.5 text-xs`}>
                {statusInfo.icon}
              </span>
              {isCurrent && "▶ "}
              {ch.title}
            </button>
          );
        })}
      </ScrollArea>
    </div>
  );
}
```

- [ ] **Step 4: Write TopBar**

Create `src/components/reader/TopBar.tsx`:

```typescript
"use client";

import { Button } from "@/components/ui/button";
import Link from "next/link";

export type ViewMode = "single" | "dual" | "triple";

interface TopBarProps {
  bookTitle: string;
  chapterTitle: string;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
}

export function TopBar({
  bookTitle,
  chapterTitle,
  viewMode,
  onViewModeChange,
  onToggleSidebar,
  onOpenSettings,
}: TopBarProps) {
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b border-border text-sm">
      <div className="flex items-center gap-3">
        <button onClick={onToggleSidebar} className="text-lg cursor-pointer">
          ☰
        </button>
        <Link href="/" className="text-muted-foreground hover:text-foreground text-xs">
          ←
        </Link>
        <span className="font-semibold">{bookTitle}</span>
        <span className="text-muted-foreground">— {chapterTitle}</span>
      </div>
      <div className="flex gap-1.5">
        {(["single", "dual", "triple"] as const).map((mode) => (
          <Button
            key={mode}
            size="sm"
            variant={viewMode === mode ? "default" : "outline"}
            className="text-xs h-7 px-2"
            onClick={() => onViewModeChange(mode)}
          >
            {mode === "single" ? "単語" : mode === "dual" ? "二語" : "三語"}
          </Button>
        ))}
        <Button size="sm" variant="outline" className="text-xs h-7 px-2" onClick={onOpenSettings}>
          Aa
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Write BottomBar**

Create `src/components/reader/BottomBar.tsx`:

```typescript
"use client";

import { Button } from "@/components/ui/button";

interface BottomBarProps {
  currentIndex: number;
  totalChapters: number;
  onPrev: () => void;
  onNext: () => void;
}

export function BottomBar({
  currentIndex,
  totalChapters,
  onPrev,
  onNext,
}: BottomBarProps) {
  const progress =
    totalChapters > 0
      ? Math.round(((currentIndex + 1) / totalChapters) * 100)
      : 0;

  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-muted/50 border-t border-border text-xs text-muted-foreground">
      <Button
        variant="ghost"
        size="sm"
        className="text-xs h-6"
        onClick={onPrev}
        disabled={currentIndex <= 0}
      >
        ← Prev
      </Button>
      <span>
        {currentIndex + 1} / {totalChapters} · {progress}%
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="text-xs h-6"
        onClick={onNext}
        disabled={currentIndex >= totalChapters - 1}
      >
        Next →
      </Button>
    </div>
  );
}
```

- [ ] **Step 6: Write ReaderLayout**

Create `src/components/reader/ReaderLayout.tsx`:

```typescript
"use client";

import { useState, useEffect, useCallback } from "react";
import { TopBar, ViewMode } from "./TopBar";
import { BottomBar } from "./BottomBar";
import { ChapterSidebar } from "./ChapterSidebar";
import { ColumnView } from "./ColumnView";
import { SettingsDrawer } from "./SettingsDrawer";

interface Chapter {
  id: string;
  index: number;
  title: string;
  status: string;
}

interface Paragraph {
  id: string;
  seq: number;
  sourceText: string;
  translations: Record<string, { text: string; status: string }>;
}

interface ChapterContent {
  id: string;
  title: string;
  status: string;
  paragraphs: Paragraph[];
}

interface ReaderLayoutProps {
  bookId: string;
  bookTitle: string;
  sourceLang: string;
  chapters: Chapter[];
  initialChapterIndex: number;
}

const LANG_LABELS: Record<string, string> = {
  ja: "日本語",
  zh: "中文",
  en: "English",
};

const ALL_LANGS = ["ja", "zh", "en"];

const DEFAULT_SETTINGS = {
  fontSize: 16,
  lineHeight: 1.8,
  paragraphSpacing: "standard" as const,
  theme: "dark",
  fonts: { ja: "var(--font-noto-jp), serif", zh: "var(--font-noto-sc), serif", en: "Georgia, serif" },
};

export function ReaderLayout({
  bookId,
  bookTitle,
  sourceLang,
  chapters,
  initialChapterIndex,
}: ReaderLayoutProps) {
  const [currentIndex, setCurrentIndex] = useState(initialChapterIndex);
  const [content, setContent] = useState<ChapterContent | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("triple");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  const currentChapter = chapters.find((ch) => ch.index === currentIndex);

  // Determine which languages to show
  const visibleLangs = (() => {
    const otherLangs = ALL_LANGS.filter((l) => l !== sourceLang);
    if (viewMode === "single") return [sourceLang];
    if (viewMode === "dual") return [sourceLang, otherLangs[0]];
    return [sourceLang, ...otherLangs];
  })();

  // Fetch chapter content
  const fetchContent = useCallback(async (chapterId: string) => {
    const res = await fetch(`/api/chapters/${chapterId}`);
    if (res.ok) {
      setContent(await res.json());
    }
  }, []);

  // Trigger translation
  const triggerTranslation = useCallback(async (chapterId: string) => {
    await fetch(`/api/chapters/${chapterId}/translate`, { method: "POST" });
  }, []);

  // Load chapter when index changes
  useEffect(() => {
    const ch = chapters.find((c) => c.index === currentIndex);
    if (!ch) return;

    fetchContent(ch.id);

    // Trigger translation if needed
    if (ch.status === "pending") {
      triggerTranslation(ch.id);
    }

    // Save progress
    fetch(`/api/progress/${bookId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapterIndex: currentIndex }),
    });

    // Prefetch next chapter
    const nextCh = chapters.find((c) => c.index === currentIndex + 1);
    if (nextCh && nextCh.status === "pending") {
      triggerTranslation(nextCh.id);
    }
  }, [currentIndex, chapters, bookId, fetchContent, triggerTranslation]);

  // Poll for translation status
  useEffect(() => {
    if (!currentChapter || !content) return;
    if (content.status === "done") return;

    const interval = setInterval(async () => {
      if (!currentChapter) return;
      await fetchContent(currentChapter.id);
    }, 3000);

    return () => clearInterval(interval);
  }, [currentChapter, content, fetchContent]);

  return (
    <div className="h-screen flex flex-col bg-background">
      <TopBar
        bookTitle={bookTitle}
        chapterTitle={currentChapter?.title || ""}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="flex flex-1 overflow-hidden">
        <ChapterSidebar
          chapters={chapters}
          currentIndex={currentIndex}
          onSelect={setCurrentIndex}
          isOpen={sidebarOpen}
        />

        <div className="flex flex-1 overflow-hidden divide-x divide-border">
          {content?.paragraphs &&
            visibleLangs.map((lang) => (
              <ColumnView
                key={lang}
                lang={lang}
                label={LANG_LABELS[lang] || lang}
                sourceLang={sourceLang}
                paragraphs={content.paragraphs}
                highlightedId={highlightedId}
                onParagraphClick={setHighlightedId}
                fontSize={settings.fontSize}
                lineHeight={settings.lineHeight}
                fontFamily={settings.fonts[lang as keyof typeof settings.fonts] || "serif"}
              />
            ))}

          {!content && (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              Loading...
            </div>
          )}
        </div>
      </div>

      <BottomBar
        currentIndex={currentIndex}
        totalChapters={chapters.length}
        onPrev={() => setCurrentIndex((i) => Math.max(0, i - 1))}
        onNext={() => setCurrentIndex((i) => Math.min(chapters.length - 1, i + 1))}
      />

      <SettingsDrawer
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSettingsChange={setSettings}
      />
    </div>
  );
}
```

- [ ] **Step 7: Write reader page**

Create `src/app/read/[bookId]/page.tsx`:

```typescript
import { getDb } from "@/lib/db";
import { books, chapters, readingProgress } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { ReaderLayout } from "@/components/reader/ReaderLayout";
import { ensureDataDir } from "@/lib/db/init";

export default async function ReadPage({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = await params;
  ensureDataDir();
  const db = getDb();

  const book = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book) notFound();

  const chapterList = db
    .select({
      id: chapters.id,
      index: chapters.index,
      title: chapters.title,
      status: chapters.status,
    })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(chapters.index)
    .all();

  const progress = db
    .select()
    .from(readingProgress)
    .where(eq(readingProgress.bookId, bookId))
    .get();

  return (
    <ReaderLayout
      bookId={bookId}
      bookTitle={book.title}
      sourceLang={book.sourceLang}
      chapters={chapterList}
      initialChapterIndex={progress?.chapterIndex || 0}
    />
  );
}
```

- [ ] **Step 8: Verify dev server**

Run: `npm run dev`
Expected: Reader page renders at `/read/[bookId]` (will need a book uploaded first to test fully)

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add trilingual reader layout with columns, sidebar, and navigation"
```

---

## Task 11: Settings Drawer

**Files:**
- Create: `src/components/reader/SettingsDrawer.tsx`

- [ ] **Step 1: Write SettingsDrawer**

Create `src/components/reader/SettingsDrawer.tsx`:

```typescript
"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

interface Settings {
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: "compact" | "standard" | "relaxed";
  theme: string;
  fonts: {
    ja: string;
    zh: string;
    en: string;
  };
}

interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  settings: Settings;
  onSettingsChange: (settings: Settings) => void;
}

const FONT_OPTIONS = {
  ja: [
    { label: "Noto Serif JP", value: "var(--font-noto-jp), serif" },
    { label: "Sans-serif", value: "system-ui, sans-serif" },
  ],
  zh: [
    { label: "Noto Serif SC", value: "var(--font-noto-sc), serif" },
    { label: "Sans-serif", value: "system-ui, sans-serif" },
  ],
  en: [
    { label: "Georgia", value: "Georgia, serif" },
    { label: "Times New Roman", value: "'Times New Roman', serif" },
    { label: "Sans-serif", value: "system-ui, sans-serif" },
  ],
};

const SPACING_OPTIONS = [
  { label: "Compact", value: "compact" },
  { label: "Standard", value: "standard" },
  { label: "Relaxed", value: "relaxed" },
];

export function SettingsDrawer({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
}: SettingsDrawerProps) {
  const update = (partial: Partial<Settings>) => {
    onSettingsChange({ ...settings, ...partial });
  };

  const updateFont = (lang: keyof Settings["fonts"], value: string) => {
    onSettingsChange({
      ...settings,
      fonts: { ...settings.fonts, [lang]: value },
    });
  };

  return (
    <Sheet open={isOpen} onOpenChange={onClose}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Reading Settings</SheetTitle>
        </SheetHeader>

        <div className="space-y-6 mt-6">
          {/* Font Size */}
          <div>
            <Label className="mb-2 block">
              Font Size: {settings.fontSize}px
            </Label>
            <Slider
              value={[settings.fontSize]}
              min={12}
              max={28}
              step={1}
              onValueChange={([v]) => update({ fontSize: v })}
            />
          </div>

          {/* Line Height */}
          <div>
            <Label className="mb-2 block">
              Line Height: {settings.lineHeight}x
            </Label>
            <Slider
              value={[settings.lineHeight * 10]}
              min={12}
              max={30}
              step={1}
              onValueChange={([v]) => update({ lineHeight: v / 10 })}
            />
          </div>

          {/* Paragraph Spacing */}
          <div>
            <Label className="mb-2 block">Paragraph Spacing</Label>
            <Select
              value={settings.paragraphSpacing}
              onValueChange={(v) =>
                update({
                  paragraphSpacing: v as Settings["paragraphSpacing"],
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SPACING_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Separator />

          {/* Fonts per language */}
          {(["ja", "zh", "en"] as const).map((lang) => (
            <div key={lang}>
              <Label className="mb-2 block">
                {lang === "ja"
                  ? "Japanese Font"
                  : lang === "zh"
                    ? "Chinese Font"
                    : "English Font"}
              </Label>
              <Select
                value={settings.fonts[lang]}
                onValueChange={(v) => updateFont(lang, v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FONT_OPTIONS[lang].map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}

          <Separator />

          {/* Theme */}
          <div>
            <Label className="mb-2 block">Theme</Label>
            <Select
              value={settings.theme}
              onValueChange={(v) => update({ theme: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: Verify settings drawer opens in reader**

Run: `npm run dev`
Expected: Clicking "Aa" button in reader TopBar opens settings drawer

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add settings drawer with font, size, spacing, and theme controls"
```

---

## Task 12: Settings Page

**Files:**
- Create: `src/app/settings/page.tsx`

- [ ] **Step 1: Write settings page**

Create `src/app/settings/page.tsx`:

```typescript
"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import Link from "next/link";

interface LLMSettings {
  provider: string;
  model: string;
  apiKey: string;
  concurrency: number;
}

const MODELS: Record<string, string[]> = {
  claude: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"],
};

export default function SettingsPage() {
  const [llm, setLlm] = useState<LLMSettings>({
    provider: "claude",
    model: "claude-sonnet-4-20250514",
    apiKey: "",
    concurrency: 2,
  });
  const [saved, setSaved] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        if (data.llm) {
          setLlm(data.llm);
        }
      });
  }, []);

  const handleSave = async () => {
    const payload = {
      llm: {
        ...llm,
        ...(apiKeyInput ? { apiKey: apiKeyInput } : {}),
      },
    };

    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      setSaved(true);
      setApiKeyInput("");
      setTimeout(() => setSaved(false), 2000);
    }
  };

  return (
    <div className="min-h-screen p-6 max-w-2xl mx-auto">
      <header className="mb-8 flex items-center gap-4">
        <Link href="/" className="text-muted-foreground hover:text-foreground">
          ← Back
        </Link>
        <h1 className="text-2xl font-bold">Settings</h1>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>LLM Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="mb-2 block">Provider</Label>
            <Select
              value={llm.provider}
              onValueChange={(v) => setLlm({ ...llm, provider: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude (Anthropic)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="mb-2 block">Model</Label>
            <Select
              value={llm.model}
              onValueChange={(v) => setLlm({ ...llm, model: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(MODELS[llm.provider] || []).map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="mb-2 block">API Key</Label>
            <Input
              type="password"
              placeholder={
                llm.apiKey ? "***configured*** (enter new to update)" : "sk-ant-..."
              }
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
          </div>

          <div>
            <Label className="mb-2 block">
              Concurrency: {llm.concurrency}
            </Label>
            <Slider
              value={[llm.concurrency]}
              min={1}
              max={5}
              step={1}
              onValueChange={([v]) => setLlm({ ...llm, concurrency: v })}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Number of simultaneous translation requests
            </p>
          </div>

          <Button onClick={handleSave}>
            {saved ? "Saved!" : "Save Settings"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Add settings link to home page**

In `src/app/page.tsx`, add a settings link in the header:

```typescript
// In the <header> section, after the subtitle:
<Link href="/settings" className="text-sm text-muted-foreground hover:text-foreground">
  Settings
</Link>
```

Import `Link` from `next/link` at the top of the file.

- [ ] **Step 3: Verify settings page**

Run: `npm run dev`
Expected: Settings page at `/settings` shows LLM config form

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add settings page with LLM configuration"
```

---

## Task 13: Docker Setup

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`

- [ ] **Step 1: Write Dockerfile**

Create `Dockerfile`:

```dockerfile
FROM node:20-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder /app/node_modules/bindings ./node_modules/bindings
COPY --from=builder /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path

RUN mkdir -p /app/data/uploads /app/data/exports && \
    chown -R nextjs:nodejs /app/data

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
```

- [ ] **Step 2: Update next.config.ts for standalone output**

Add `output: "standalone"` to `next.config.ts`:

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
```

- [ ] **Step 3: Write docker-compose.yml**

Create `docker-compose.yml`:

```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - app-data:/app/data
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    restart: unless-stopped

volumes:
  app-data:
```

- [ ] **Step 4: Test Docker build**

Run:
```bash
docker compose build
```
Expected: Build completes successfully

- [ ] **Step 5: Test Docker run**

Run:
```bash
docker compose up -d
```
Expected: App accessible at http://localhost:3000

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Dockerfile and docker-compose for deployment"
```

---

## Task 14: Integration Test — End-to-End Flow

**Files:** No new files — manual verification

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Upload test EPUB**

Open http://localhost:3000, drag and drop the test EPUB (`src/lib/epub/__tests__/fixtures/test.epub`) onto the upload zone. Verify:
- Book card appears with title "テスト小説", author "テスト著者", language badge "日本語"
- Progress bar shows 0/2 chapters

- [ ] **Step 3: Open reader**

Click "Read" on the book card. Verify:
- Reader page loads with three columns (or shows "Translating...")
- Chapter sidebar shows 2 chapters
- Original Japanese text is visible immediately

- [ ] **Step 4: Configure API key and test translation**

Go to `/settings`, enter your Anthropic API key, save. Return to reader. Click translate on chapter 1. Verify:
- Paragraphs show "Translating..." status
- After a few seconds, translations appear in Chinese and English columns
- Chapter status in sidebar changes to done

- [ ] **Step 5: Test navigation and settings**

- Switch between single/dual/triple view modes
- Click a paragraph to test highlight sync
- Open settings drawer, change font size, verify it applies
- Navigate to chapter 2
- Go back to chapter 1, verify translations are cached

- [ ] **Step 6: Test export**

Use browser dev tools or curl to trigger export:
```bash
curl -X POST http://localhost:3000/api/export/{bookId} -H "Content-Type: application/json" -d '{"format":"json"}'
curl -X POST http://localhost:3000/api/export/{bookId} -H "Content-Type: application/json" -d '{"format":"html"}'
```
Verify files are created in `data/exports/`

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore: integration verification complete"
```
