# Cloud Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Prism from local SQLite+filesystem to Turso (libSQL) + Cloudflare R2, with translation jobs executed by a user-run worker process that polls Turso.

**Architecture:** Vercel (stateless Next.js) writes `pending` translation rows to Turso and files to R2. A separate Node.js worker process on the user's own machine polls Turso for pending rows, calls the local LLM, and writes results back. The worker eliminates the originally-planned Cloudflare Tunnel — it makes outbound connections and needs no public IP.

**Tech Stack:** Next.js 16, `@libsql/client`, `drizzle-orm/libsql`, `@aws-sdk/client-s3` (for R2), `pm2` (worker supervisor).

**Spec:** `docs/superpowers/specs/2026-04-15-cloud-migration-design.md`

**Testing approach:** This is a refactor, not a feature. The TypeScript compiler is the primary correctness check — swapping from `better-sqlite3` (sync) to `@libsql/client` (async) forces every DB call site to propagate `await`, and the compiler refuses to build until every site is converted. Each task ends with a concrete build-or-run verification step, not a new unit test. The project's existing tests (a single file at `src/lib/llm/__tests__/provider.test.ts`) must continue to pass.

---

## File Map

**New files:**
- `worker/index.ts` — poll loop
- `worker/translate.ts` — single-job handler (claim, translate, write result)
- `worker/ecosystem.config.cjs` — PM2 process definition
- `worker/README.md` — setup instructions for user
- `src/lib/llm/settings.ts` — `loadLLMSettings()` extracted from deleted queue file, shared by worker
- `.env.example` — Vercel env template
- `.env.worker.example` — worker env template

**Modified (major logic changes):**
- `package.json` — add `@libsql/client`, `@aws-sdk/client-s3`; add `worker` and `build` scripts; remove `better-sqlite3` and `@types/better-sqlite3`
- `src/lib/db/index.ts` — libsql client replacing better-sqlite3
- `src/lib/db/migrate.ts` — libsql migrator
- `src/instrumentation.ts` — remove migrate + resume calls (likely deleted entirely)
- `src/lib/storage.ts` — add `R2Storage` class and `STORAGE_DRIVER` switch in factories
- `src/lib/translate/enqueue.ts` — async; write `pending` rows only, no `queue.add()`
- `src/app/api/books/upload/route.ts` — wrap bulk inserts in `db.transaction`
- `src/lib/export/exporter.ts` — stream ZIP directly to storage.openWriteStream

**Modified (mechanical `await` propagation — ~29 files):**
All other files using `getDb()` or `getSqlite()`. Full list in Task 2.

**Deleted:**
- `src/lib/queue/translation-queue.ts` (superseded by worker)
- `src/lib/translate/resume.ts` (worker self-resumes)

---

## Task 1: Install dependencies and seed env templates

**Files:**
- Modify: `package.json`
- Create: `.env.example`
- Create: `.env.worker.example`

- [ ] **Step 1: Update package.json dependencies**

Run: `npm install @libsql/client @aws-sdk/client-s3 && npm install --save-dev pm2`

Then manually remove `better-sqlite3` and `@types/better-sqlite3` from `package.json` dependencies. **Do not run `npm uninstall` yet** — we'll do that in Task 10 after the driver swap is complete. For now, both drivers coexist.

- [ ] **Step 2: Add scripts to package.json**

Edit `package.json` `scripts`:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "npm run db:migrate && next build",
    "start": "next start",
    "lint": "eslint",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:migrate": "tsx src/lib/db/migrate.ts",
    "worker": "tsx worker/index.ts",
    "worker:pm2": "pm2 start worker/ecosystem.config.cjs"
  }
}
```

`build` now runs migrations before `next build` so Vercel applies schema changes during deploy.

- [ ] **Step 3: Create `.env.example` (Vercel / production)**

Write to `.env.example`:

```
# Clerk — get from https://dashboard.clerk.com
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxx
CLERK_SECRET_KEY=sk_test_xxx

# Admin whitelist (comma-separated emails)
ADMIN_EMAILS=you@example.com

# Database — libSQL. Use file: URL for local, libsql:// for Turso.
TURSO_DATABASE_URL=file:./data/db.sqlite
TURSO_AUTH_TOKEN=

# Storage driver: "fs" (local) or "r2" (cloud)
STORAGE_DRIVER=fs

# R2 credentials (required when STORAGE_DRIVER=r2)
R2_ACCOUNT_ID=
R2_BUCKET=
R2_ENDPOINT=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
```

- [ ] **Step 4: Create `.env.worker.example`**

Write to `.env.worker.example`:

```
# Worker connects to the same DB as Vercel does. Point at the Turso URL in
# production, or the same file: URL as .env.local when running locally.
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=

# Local LLM endpoint on this machine. Ollama default shown.
LLM_PROVIDER=ollama
LLM_PROVIDER_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen2.5:7b

# Poll interval in ms. Lower = faster pickup, more Turso read traffic.
WORKER_POLL_INTERVAL_MS=2000

# Max parallel translations this worker handles. Keep ≤ your LLM's capacity.
WORKER_CONCURRENCY=2
```

- [ ] **Step 5: Verify install**

Run: `npm install`
Expected: clean install, no peer-dep warnings for the new packages.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .env.example .env.worker.example
git commit -m "chore: add libsql and R2 SDK deps, env templates"
```

---

## Task 2: Swap DB driver to `@libsql/client` and propagate awaits

This is the largest task. After it lands, every DB call site in the app awaits libsql instead of returning synchronously from better-sqlite3.

**Files:**
- Modify: `src/lib/db/index.ts`
- Modify: all 29 files listed below

**Call site inventory** (grep `getDb|getSqlite` produced this list):
- `src/lib/db/index.ts` (the driver itself)
- `src/lib/access.ts`
- `src/lib/auth.ts`
- `src/lib/billing.ts`
- `src/lib/chapter-status.ts`
- `src/lib/collections.ts`
- `src/lib/dict/installer.ts`
- `src/lib/dict/lookup.ts`
- `src/lib/export/exporter.ts`
- `src/lib/translate/cancel.ts`
- `src/lib/translate/enqueue.ts`
- `src/lib/translate/resume.ts` (will be deleted in Task 10, but convert now to keep build green)
- `src/app/read/[bookId]/page.tsx`
- `src/app/api/books/route.ts`
- `src/app/api/books/upload/route.ts`
- `src/app/api/books/import/route.ts`
- `src/app/api/books/translate-all/route.ts`
- `src/app/api/books/translate-cancel-all/route.ts`
- `src/app/api/books/[id]/route.ts`
- `src/app/api/books/[id]/export/route.ts`
- `src/app/api/books/[id]/translate-all/route.ts`
- `src/app/api/collections/route.ts`
- `src/app/api/collections/[id]/route.ts`
- `src/app/api/collections/[id]/books/route.ts`
- `src/app/api/chapters/[id]/route.ts`
- `src/app/api/chapters/[id]/status/route.ts`
- `src/app/api/paragraphs/[id]/retry/route.ts`
- `src/app/api/progress/[bookId]/route.ts`
- `src/app/api/vocabulary/route.ts`
- `src/app/api/vocabulary/[id]/route.ts`
- `src/app/api/vocabulary/[id]/review/route.ts`

- [ ] **Step 1: Rewrite `src/lib/db/index.ts`**

Replace entire file:

```ts
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

const url = process.env.TURSO_DATABASE_URL;
if (!url) throw new Error("TURSO_DATABASE_URL is required");

let _client: Client | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (!_db) {
    _client = createClient({
      url,
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    });
    _db = drizzle(_client, { schema });
  }
  return _db;
}

/**
 * Raw libsql client. Use for FTS5 virtual tables and other features
 * Drizzle's DSL doesn't model. Returns a Client with `.execute({ sql, args })`.
 */
export function getLibsqlClient(): Client {
  getDb();
  return _client!;
}
```

**Breaking change:** `getSqlite()` is renamed to `getLibsqlClient()`. Better-sqlite3's `Database` class exposes `.prepare(sql).all(...)`; libsql's `Client` exposes `.execute({ sql, args })`. Every caller that used `getSqlite()` must be rewritten in this task.

- [ ] **Step 2: Propagate awaits across all call sites**

**Search-and-replace plan** (use subagent with grep + Edit for this bulk change). The patterns below cover >95% of sites; the rest will surface as TS errors.

For Drizzle query builder calls, the transform is:

```ts
// Before (better-sqlite3, sync)
const row = db.select().from(books).where(eq(books.id, id)).get();
const rows = db.select().from(books).all();
db.insert(books).values({...}).run();
db.update(books).set({...}).where(eq(books.id, id)).run();
db.delete(books).where(eq(books.id, id)).run();

// After (libsql, async)
const row = await db.select().from(books).where(eq(books.id, id)).get();
const rows = await db.select().from(books).all();
await db.insert(books).values({...}).run();
await db.update(books).set({...}).where(eq(books.id, id)).run();
await db.delete(books).where(eq(books.id, id)).run();
```

Every `.get()`, `.all()`, `.run()`, `.values()`, `.returning()` at end of a drizzle chain needs `await` before it.

For transactions:

```ts
// Before (sync)
db.transaction(() => {
  for (const p of paragraphs) db.insert(...).values({...}).run();
})();

// After (async)
await db.transaction(async (tx) => {
  for (const p of paragraphs) await tx.insert(...).values({...}).run();
});
```

Callers must be in an `async` function. All route handlers in Next.js App Router already return promises so their `async` signature can be added if not already present.

- [ ] **Step 3: Rewrite `getSqlite()` callers**

Grep for `getSqlite` to find them:

```bash
grep -rn "getSqlite" src/
```

Each call site used `sqlite.prepare(sql).get(args)` or `.all(args)` or `.run(args)`. Transform to:

```ts
// Before
import { getSqlite } from "@/lib/db";
const sqlite = getSqlite();
const row = sqlite.prepare("SELECT * FROM foo WHERE id = ?").get(id);

// After
import { getLibsqlClient } from "@/lib/db";
const client = getLibsqlClient();
const { rows } = await client.execute({
  sql: "SELECT * FROM foo WHERE id = ?",
  args: [id],
});
const row = rows[0];
```

Note: libsql returns `{ rows, columns, rowsAffected, lastInsertRowid }`. FTS5 callers in `src/lib/dict/lookup.ts` and `src/lib/dict/installer.ts` use raw SQL — convert each to `client.execute()`.

- [ ] **Step 4: Run TypeScript build to find missed awaits**

Run: `npx tsc --noEmit`
Expected first run: many errors of the form:

```
Property 'id' does not exist on type 'Promise<{ id: string; ... }>'.
```

Each error is a missed `await`. Fix them and re-run until output is clean.

- [ ] **Step 5: Run the full build**

Run: `npm run build`
Expected: clean build, no TS errors.

Note: `npm run build` also runs `npm run db:migrate`, which will fail because Task 3 hasn't rewritten the migrator yet. For this task only, run `npx next build` directly to skip migrations.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: swap DB driver from better-sqlite3 to libsql"
```

---

## Task 3: Rewrite migrator and remove instrumentation hook

**Files:**
- Modify: `src/lib/db/migrate.ts`
- Modify: `src/instrumentation.ts`

- [ ] **Step 1: Rewrite `src/lib/db/migrate.ts`**

Replace entire file:

```ts
import "dotenv/config";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import path from "path";

export async function runMigrations() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is required for migrations");

  const client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  client.close();
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log("Migrations complete.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
```

- [ ] **Step 2: Replace `src/instrumentation.ts`**

Replace entire file with:

```ts
export async function register() {
  // Migrations now run in the build step (npm run db:migrate before next build).
  // Translation resume now runs inside the worker process, not on cold start.
  // This hook is intentionally empty; Next.js requires the file to exist if
  // it's referenced in next.config, otherwise this file can be deleted.
}
```

If `next.config.ts` / `next.config.js` doesn't reference `instrumentationHook`, delete the file entirely instead:

```bash
rm src/instrumentation.ts
```

Check with: `grep -n "instrumentation" next.config.*` — if no match, delete.

- [ ] **Step 3: Add `dotenv` dependency**

The migrator script needs to read `.env.local` when run via `npm run db:migrate` (not a Next.js runtime). Install:

```bash
npm install dotenv
```

- [ ] **Step 4: Verify migrations run**

Run against the local SQLite file (make sure `.env.local` has `TURSO_DATABASE_URL=file:./data/db.sqlite`):

```bash
npm run db:migrate
```

Expected: `Migrations complete.` No errors.

- [ ] **Step 5: Verify full build**

Run: `npm run build`
Expected: migrations run, then Next build succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move migrations to build step, use libsql migrator"
```

---

## Task 4: Add R2 storage backend

**Files:**
- Modify: `src/lib/storage.ts`

- [ ] **Step 1: Add `R2Storage` class to `src/lib/storage.ts`**

Append after `LocalFsStorage` class (before the module-level `BASE`/`_uploads` etc.):

```ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  NoSuchKey,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { PassThrough } from "stream";

class R2Storage implements Storage {
  private client: S3Client;
  constructor(private readonly bucket: string, private readonly prefix: string) {
    const endpoint = process.env.R2_ENDPOINT;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error("R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY required");
    }
    this.client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  private keyOf(key: string): string {
    // Keep the same path-basename guard as LocalFsStorage — prevents a
    // caller from escaping our prefix with `../` or an absolute key.
    const safe = key.replace(/^\/+/, "");
    if (safe.includes("..") || safe !== key.replace(/^\/+/, "")) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return `${this.prefix}/${safe}`;
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.keyOf(key),
        Body: typeof data === "string" ? Buffer.from(data) : data,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.keyOf(key) }),
      );
      const chunks: Buffer[] = [];
      // Body is a Readable stream in Node.
      for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk);
      return Buffer.concat(chunks);
    } catch (err) {
      if (err instanceof NoSuchKey) {
        throw Object.assign(new Error(`Not found: ${key}`), { code: "ENOENT" });
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.keyOf(key) }),
    );
  }

  openWriteStream(key: string): fs.WriteStream {
    // Return a PassThrough that S3 multipart Upload consumes. Cast to
    // fs.WriteStream to satisfy the Storage interface — callers only use
    // event/write/end methods that both types share.
    const pass = new PassThrough();
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: this.keyOf(key),
        Body: pass,
      },
    });
    // Kick off the upload. Errors surface via the stream 'error' event.
    upload.done().catch((err) => pass.emit("error", err));
    return pass as unknown as fs.WriteStream;
  }
}
```

- [ ] **Step 2: Update factories to pick backend by env**

Replace the factory functions at the bottom of `src/lib/storage.ts`:

```ts
const BASE = path.join(process.cwd(), "data");
const DRIVER = process.env.STORAGE_DRIVER ?? "fs";
const R2_BUCKET = process.env.R2_BUCKET ?? "";

let _uploads: Storage | null = null;
let _exports: Storage | null = null;
let _covers: Storage | null = null;

function make(fsSubdir: string, r2Prefix: string): Storage {
  if (DRIVER === "r2") return new R2Storage(R2_BUCKET, r2Prefix);
  return new LocalFsStorage(path.join(BASE, fsSubdir));
}

export function getUploadsStorage(): Storage {
  if (!_uploads) _uploads = make("uploads", "uploads");
  return _uploads;
}

export function getExportsStorage(): Storage {
  if (!_exports) _exports = make("exports", "exports");
  return _exports;
}

export function getCoversStorage(): Storage {
  if (!_covers) _covers = make("covers", "covers");
  return _covers;
}
```

- [ ] **Step 3: Install the multipart upload helper**

```bash
npm install @aws-sdk/lib-storage
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 5: Verify local dev still works**

With `.env.local` containing `STORAGE_DRIVER=fs`:

```bash
npm run dev
```

Open the app, upload a small EPUB from `test-novel/`. Confirm file lands under `data/uploads/`. No behaviour change from before.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add R2 storage backend, STORAGE_DRIVER env switch"
```

---

## Task 5: Wrap upload bulk inserts in a transaction

Turso charges per write request. A 50-chapter EPUB currently fires 200+ individual writes; batching into a single transaction collapses them to one request.

**Files:**
- Modify: `src/app/api/books/upload/route.ts` (lines ~95–150)

- [ ] **Step 1: Read the current upload route**

Open `src/app/api/books/upload/route.ts`. The relevant block is the sequence of `db.insert(books).run()`, then the `for` loop over chapters that runs `db.insert(chapters).run()` and (for the first chapter) `db.insert(paragraphs).run()` for each paragraph.

- [ ] **Step 2: Wrap inserts in a transaction**

Replace the insert block (starting at the `db.insert(books).values(...)` call and ending after the chapters/paragraphs loop) with:

```ts
await db.transaction(async (tx) => {
  await tx.insert(books).values({
    id: bookId,
    title: parsed.title,
    author: parsed.author,
    sourceLang: parsed.language.substring(0, 2).toLowerCase(),
    coverPath,
    filePath: fileName,
    totalChapters: parsed.chapters.length,
    status: "parsed",
    userId: user.id,
    visibility,
    collectionId: targetCollectionId,
    collectionSeq: targetCollectionSeq,
  });

  // Batch all chapter inserts; paragraphs for chapter 0 only (rest lazy-parse).
  const chapterRows = parsed.chapters.map((ch, i) => ({
    id: randomUUID(),
    bookId,
    index: i,
    title: ch.title,
    sourceHtml: ch.sourceHtml,
    status: "pending" as const,
  }));
  if (chapterRows.length > 0) {
    // Chunk to stay under Turso's 1000-statement-per-tx recommendation.
    for (let i = 0; i < chapterRows.length; i += 500) {
      await tx.insert(chapters).values(chapterRows.slice(i, i + 500));
    }
  }

  const firstChapterId = chapterRows[0]?.id;
  if (firstChapterId && parsed.chapters[0]) {
    const paragraphRows = parsed.chapters[0].paragraphs.map((p, j) => ({
      id: randomUUID(),
      chapterId: firstChapterId,
      seq: j,
      sourceText: p.text,
      sourceMarkup: p.markup,
    }));
    for (let i = 0; i < paragraphRows.length; i += 500) {
      await tx.insert(paragraphs).values(paragraphRows.slice(i, i + 500));
    }
  }
});
```

The key change: batched `.values([...])` arrays instead of one insert per row, and the whole thing inside `db.transaction`.

- [ ] **Step 3: Also wrap `src/app/api/books/import/route.ts`**

The import route does the same bulk insert pattern. Apply the same transaction wrapping. Read the file first, then mirror the transform.

- [ ] **Step 4: Verify upload works locally**

```bash
npm run dev
```

Upload a larger EPUB (e.g. one of the longer test-novel files). Confirm:
- Book appears in library
- Chapters table populated (check with `sqlite3 data/db.sqlite "SELECT COUNT(*) FROM chapters WHERE book_id = '<id>'"`)
- First chapter's paragraphs parsed

- [ ] **Step 5: Commit**

```bash
git add src/app/api/books/upload/route.ts src/app/api/books/import/route.ts
git commit -m "perf: batch book upload inserts in single transaction"
```

---

## Task 6: Stream exports to storage

The current exporter builds the entire book in memory as a Buffer before writing. With Vercel's 1GB function memory limit, large multi-volume novels will OOM. Switch to piping through storage's `openWriteStream`.

**Files:**
- Modify: `src/lib/export/exporter.ts`

- [ ] **Step 1: Read the current exporter**

Read `src/lib/export/exporter.ts` in full to understand the current ZIP build flow (uses `archiver`).

- [ ] **Step 2: Rewrite to stream through storage**

Find the section that creates the archive and writes the final buffer. The new pattern:

```ts
import { getExportsStorage } from "@/lib/storage";
import archiver from "archiver";

export async function exportBookToZip(bookId: string): Promise<string> {
  // ... existing work to gather chapters/paragraphs/translations ...

  const key = `${bookId}-${Date.now()}.zip`;
  const storage = getExportsStorage();
  const writeStream = storage.openWriteStream(key);
  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.pipe(writeStream);

  // Append each chapter file. `append(string | Buffer, { name })`
  // buffers the entry but NOT the whole archive — entries flush
  // through the pipe as they're finalized.
  for (const ch of chapters) {
    const content = renderChapterHtml(ch, paragraphsByChapter.get(ch.id) ?? [], translationsByChapter.get(ch.id) ?? []);
    archive.append(content, { name: `chapter-${ch.index}.html` });
  }
  archive.append(renderMetadata(book), { name: "metadata.json" });

  await archive.finalize();
  // Wait for the write stream (PassThrough → R2 Upload) to flush.
  await new Promise<void>((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });

  return key;
}
```

Keep the existing logic that reads DB rows and builds HTML; only the sink changes from "Buffer to return" to "stream to storage, return key".

- [ ] **Step 3: Update the export route to return a redirect**

If the route currently returns the Buffer, change it to either:
- Return `{ key }` JSON and have the client GET `/api/exports/<key>` that streams from storage, or
- Return a presigned R2 URL directly.

For simplicity, keep a server-side read route: `src/app/api/exports/[key]/route.ts` that streams `getExportsStorage().get(key)` to the HTTP response. Create it if it doesn't exist.

- [ ] **Step 4: Verify export works**

```bash
npm run dev
```

Trigger an export from the UI. Confirm ZIP downloads and opens correctly.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "perf: stream exports through storage instead of buffering"
```

---

## Task 7: Extract shared translation settings and executor

The worker needs the same "load settings → create provider → translate" logic that `translation-queue.ts` had. Factor it out so both the (soon-to-be-smaller) Next.js side and the worker can import it.

**Files:**
- Create: `src/lib/llm/settings.ts`
- Create: `src/lib/llm/executor.ts`

- [ ] **Step 1: Create `src/lib/llm/settings.ts`**

Extract from the deleted-in-Task-10 `translation-queue.ts`:

```ts
import fs from "fs";
import path from "path";

export interface LLMSettings {
  provider: string;
  apiKey: string;
  concurrency: number;
  baseURL?: string;
  model?: string;
}

const SETTINGS_PATH = path.join(process.cwd(), "data", "settings.json");

/**
 * Load LLM configuration. Priority order:
 * 1. LLM_PROVIDER / LLM_PROVIDER_BASE_URL / LLM_MODEL env vars (worker side)
 * 2. data/settings.json (Vercel side — but Vercel can't write so this is
 *    effectively a local-dev fallback)
 * 3. Defaults
 *
 * For Claude, ANTHROPIC_API_KEY env takes precedence over settings.json.
 */
export function loadLLMSettings(): LLMSettings {
  // Env-var mode (worker)
  if (process.env.LLM_PROVIDER) {
    return {
      provider: process.env.LLM_PROVIDER,
      apiKey: process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
      baseURL: process.env.LLM_PROVIDER_BASE_URL,
      model: process.env.LLM_MODEL,
    };
  }
  // File mode (local dev)
  try {
    const data = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(data);
    const provider = parsed.llm?.provider ?? "claude";
    const apiKey =
      provider === "claude" && process.env.ANTHROPIC_API_KEY
        ? process.env.ANTHROPIC_API_KEY
        : parsed.llm?.apiKey ?? "";
    return {
      provider,
      apiKey,
      concurrency: parsed.llm?.concurrency ?? 2,
    };
  } catch {
    return { provider: "claude", apiKey: "", concurrency: 2 };
  }
}

export function getActiveProviderName(): string {
  return loadLLMSettings().provider;
}

export function isLocalProvider(): boolean {
  return getActiveProviderName() === "ollama";
}
```

- [ ] **Step 2: Create `src/lib/llm/executor.ts`**

A single-row translator that reads the paragraph + source lang + target lang, calls the provider, and writes the result. The worker calls this after claiming a row.

```ts
import { getDb } from "@/lib/db";
import { books, chapters, paragraphs, translations } from "@/lib/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { createProvider } from "@/lib/llm/factory";
import { loadLLMSettings } from "@/lib/llm/settings";
import type { LLMProvider } from "@/lib/llm/types";
import { checkChapterDone } from "@/lib/chapter-status";

let _provider: LLMProvider | null = null;
function provider(): LLMProvider {
  if (!_provider) {
    const s = loadLLMSettings();
    const p = createProvider(s.provider, s.apiKey);
    // ollama via OpenAIProvider accepts a baseURL override through factory.ts
    // already. If executor needs custom baseURL beyond that, extend factory.
    _provider = p;
  }
  return _provider;
}

/** Translate a single claimed row. Caller has already set its status to
 *  'processing' via an atomic UPDATE. */
export async function runTranslation(translationId: string): Promise<void> {
  const db = getDb();

  // Fetch paragraph + book's sourceLang in one shot.
  const row = await db
    .select({
      id: translations.id,
      lang: translations.lang,
      status: translations.status,
      paragraphId: paragraphs.id,
      sourceText: paragraphs.sourceText,
      chapterId: paragraphs.chapterId,
      sourceLang: books.sourceLang,
    })
    .from(translations)
    .innerJoin(paragraphs, eq(paragraphs.id, translations.paragraphId))
    .innerJoin(chapters, eq(chapters.id, paragraphs.chapterId))
    .innerJoin(books, eq(books.id, chapters.bookId))
    .where(eq(translations.id, translationId))
    .get();

  if (!row) return;
  // A late cancel between claim and this read — leave the row as-is.
  if (row.status === "cancelled") return;

  try {
    const result = await provider().translate(
      row.sourceText,
      row.sourceLang,
      row.lang,
    );
    await db
      .update(translations)
      .set({
        text: result.text,
        status: "done",
        model: result.model,
        tokensUsed: result.tokensUsed,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(translations.id, translationId), ne(translations.status, "cancelled")));
    await checkChapterDone(row.chapterId);
  } catch (err) {
    await db
      .update(translations)
      .set({
        status: "failed",
        errorMessage: (err as Error).message,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(translations.id, translationId), ne(translations.status, "cancelled")));
    await checkChapterDone(row.chapterId);
  }
}
```

- [ ] **Step 3: Update `src/lib/queue/translation-queue.ts` callers in non-worker code**

A few call sites still import `getActiveProviderName` / `isLocalProvider` from the queue file. Update imports to pull from the new `src/lib/llm/settings.ts`:

```bash
grep -rn "from \"@/lib/queue/translation-queue\"" src/
```

For each, change to `from "@/lib/llm/settings"`. (Only `getActiveProviderName`, `isLocalProvider`, and `loadLLMSettings` move; nothing else.)

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: extract shared LLM settings and translation executor"
```

---

## Task 8: Rewrite `enqueue.ts` to only persist pending rows

With the worker architecture, the Next.js enqueue path doesn't dispatch to an in-process queue. It only writes `pending` rows; the worker picks them up.

**Files:**
- Modify: `src/lib/translate/enqueue.ts`

- [ ] **Step 1: Replace `src/lib/translate/enqueue.ts`**

Rewrite the file. Keep the paragraph-parsing logic, keep `estimateChapterWork`, but remove all references to `getTranslationQueue` and the `queue.add({...})` block. The function returns after writing `pending` rows and flipping chapter status to `translating`:

```ts
import { getDb } from "@/lib/db";
import { chapters, paragraphs, translations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
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

export async function enqueueChapterTranslations(
  chapterId: string,
  sourceLang: string,
): Promise<EnqueueResult> {
  const db = getDb();

  let paras = await db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.chapterId, chapterId))
    .orderBy(paragraphs.seq)
    .all();

  if (paras.length === 0) {
    const chapter = await db
      .select()
      .from(chapters)
      .where(eq(chapters.id, chapterId))
      .get();
    if (!chapter) {
      return { queued: 0, skippedDone: 0, totalParagraphs: 0, queuedChars: 0 };
    }

    const $ = await import("cheerio").then((m) =>
      m.load(chapter.sourceHtml, { xmlMode: true }),
    );
    const extracted: { text: string; markup: string }[] = [];
    $("body p, p").each((_, el) => {
      const text = $(el).text().trim();
      if (text.length === 0) return;
      const markup = $.html(el) || "";
      extracted.push({ text, markup });
    });

    if (extracted.length > 0) {
      await db.transaction(async (tx) => {
        const rows = extracted.map((e, j) => ({
          id: randomUUID(),
          chapterId,
          seq: j,
          sourceText: e.text,
          sourceMarkup: e.markup,
        }));
        for (let i = 0; i < rows.length; i += 500) {
          await tx.insert(paragraphs).values(rows.slice(i, i + 500));
        }
      });
    }

    paras = await db
      .select()
      .from(paragraphs)
      .where(eq(paragraphs.chapterId, chapterId))
      .orderBy(paragraphs.seq)
      .all();
  }

  const targetLangs = TARGET_LANGS[sourceLang] || ["zh", "en"];
  let queued = 0;
  let skippedDone = 0;
  let queuedChars = 0;

  await db.transaction(async (tx) => {
    for (const para of paras) {
      const existingForPara = await tx
        .select()
        .from(translations)
        .where(eq(translations.paragraphId, para.id))
        .all();

      for (const lang of targetLangs) {
        const existing = existingForPara.find((t) => t.lang === lang);
        if (existing && existing.status === "done") {
          skippedDone++;
          continue;
        }

        if (!existing) {
          await tx.insert(translations).values({
            id: randomUUID(),
            paragraphId: para.id,
            lang,
            status: "pending",
          });
        } else {
          await tx
            .update(translations)
            .set({
              status: "pending",
              errorMessage: null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(translations.id, existing.id));
        }
        queued++;
        queuedChars += para.sourceText.length;
      }
    }

    if (queued > 0) {
      await tx
        .update(chapters)
        .set({ status: "translating", updatedAt: new Date().toISOString() })
        .where(eq(chapters.id, chapterId));
    }
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
    .where(eq(paragraphs.chapterId, chapterId))
    .all();

  const targetLangs = TARGET_LANGS[sourceLang] || ["zh", "en"];

  if (paras.length === 0) {
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

  let queuedChars = 0;
  let queuedTranslations = 0;

  for (const para of paras) {
    const existingForPara = await db
      .select()
      .from(translations)
      .where(eq(translations.paragraphId, para.id))
      .all();
    for (const lang of targetLangs) {
      const existing = existingForPara.find((t) => t.lang === lang);
      if (existing && existing.status === "done") continue;
      queuedTranslations++;
      queuedChars += para.sourceText.length;
    }
  }

  return { queuedChars, queuedTranslations };
}
```

`estimateChapterWork` is now `async` — callers that used its return synchronously must `await`.

- [ ] **Step 2: Fix callers of `estimateChapterWork`**

Grep for callers:

```bash
grep -rn "estimateChapterWork" src/
```

Add `await` in front of each call.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: enqueue writes pending rows only; worker does the work"
```

---

## Task 9: Build the worker

**Files:**
- Create: `worker/index.ts`
- Create: `worker/ecosystem.config.cjs`
- Modify: `tsconfig.json` (add `worker/**/*` to `include`)

- [ ] **Step 1: Update `tsconfig.json` to include the worker directory**

Open `tsconfig.json`. The `include` array likely lists `"src/**/*"` or similar. Add `"worker/**/*"` alongside it so path aliases (`@/lib/...`) resolve when `tsx` runs the worker:

```json
{
  "include": ["src/**/*", "worker/**/*", "next-env.d.ts"]
}
```

Keep other keys (compilerOptions, exclude) unchanged.

- [ ] **Step 2: Create `worker/index.ts`**

```ts
import "dotenv/config";
import { getLibsqlClient } from "../src/lib/db";
import { runTranslation } from "../src/lib/llm/executor";

const POLL_INTERVAL = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 2);

let shuttingDown = false;
let inFlight = 0;

process.on("SIGINT", () => {
  console.log("[worker] SIGINT — finishing in-flight jobs then exiting");
  shuttingDown = true;
});

async function claimOne(): Promise<string | null> {
  const client = getLibsqlClient();
  // Atomic claim: flip exactly one pending row to processing and return its id.
  // The subquery picks the oldest pending; RETURNING surfaces what we grabbed.
  const now = new Date().toISOString();
  const res = await client.execute({
    sql: `UPDATE translations
          SET status = 'processing', updated_at = ?
          WHERE id = (
            SELECT id FROM translations
            WHERE status = 'pending'
            ORDER BY created_at
            LIMIT 1
          )
          RETURNING id`,
    args: [now],
  });
  const row = res.rows[0];
  return row ? (row.id as string) : null;
}

async function resetStaleProcessing(): Promise<void> {
  // On startup, reset rows stuck in 'processing' from a prior worker that
  // died mid-flight. Safe to run every boot: a currently-running worker
  // claims fresh rows each poll, not already-processing ones.
  const client = getLibsqlClient();
  const now = new Date().toISOString();
  const res = await client.execute({
    sql: "UPDATE translations SET status='pending', updated_at=? WHERE status='processing'",
    args: [now],
  });
  if (res.rowsAffected > 0) {
    console.log(`[worker] Reset ${res.rowsAffected} stuck 'processing' rows to 'pending'`);
  }
}

async function loop() {
  await resetStaleProcessing();
  console.log(`[worker] Starting (poll=${POLL_INTERVAL}ms, concurrency=${CONCURRENCY})`);

  while (!shuttingDown) {
    if (inFlight >= CONCURRENCY) {
      await sleep(POLL_INTERVAL);
      continue;
    }
    const id = await claimOne();
    if (!id) {
      await sleep(POLL_INTERVAL);
      continue;
    }
    inFlight++;
    runTranslation(id)
      .catch((err) => console.error(`[worker] runTranslation(${id}) threw:`, err))
      .finally(() => {
        inFlight--;
      });
  }

  // Drain
  while (inFlight > 0) await sleep(100);
  console.log("[worker] Shutdown complete");
  process.exit(0);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

loop().catch((err) => {
  console.error("[worker] Fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 3: Create `worker/ecosystem.config.cjs` (PM2)**

```js
module.exports = {
  apps: [
    {
      name: "prism-worker",
      script: "tsx",
      args: "worker/index.ts",
      cwd: __dirname + "/..",
      env_file: ".env.worker",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      out_file: "./logs/worker-out.log",
      error_file: "./logs/worker-err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
```

- [ ] **Step 4: Smoke test worker locally**

Open two terminals.

Terminal A (app): `npm run dev`
Terminal B (worker): `npm run worker`

With both running:
1. Sign in to the app
2. Upload a small EPUB from `test-novel/`
3. For a regular user: purchase the "First 3 chapters" bundle (admin: click Translate directly)
4. Watch Terminal B — you should see it pick up and process translation rows
5. Refresh the book's read page — translations appear

- [ ] **Step 5: Verify graceful shutdown**

In Terminal B, press Ctrl+C. The worker should print "finishing in-flight jobs then exiting" and exit cleanly within a few seconds.

- [ ] **Step 6: Commit**

```bash
git add worker/
git commit -m "feat: add translation worker process with atomic claim"
```

---

## Task 10: Delete obsolete queue and resume files

Now that the worker is running, delete the in-memory queue plumbing.

**Files:**
- Delete: `src/lib/queue/translation-queue.ts`
- Delete: `src/lib/translate/resume.ts`
- Possibly delete: `src/lib/queue/` directory if empty
- Modify: any stragglers that still import from the deleted files

- [ ] **Step 1: Find remaining imports**

```bash
grep -rn "translation-queue\|translate/resume" src/
```

- [ ] **Step 2: Fix each caller**

For `getTranslationQueue`: all call sites are now gone (removed in Task 8 enqueue rewrite). If any remain, delete the import and the `.add()` call.

For `getActiveProviderName` / `isLocalProvider`: already moved to `src/lib/llm/settings.ts` in Task 7. Update imports.

For `resumePendingTranslations`: only called from `instrumentation.ts`, which was cleared in Task 3. Remove any leftover imports.

- [ ] **Step 3: Delete files**

```bash
rm src/lib/queue/translation-queue.ts
rm src/lib/translate/resume.ts
# If src/lib/queue/ is now empty:
rmdir src/lib/queue
```

- [ ] **Step 4: Remove `better-sqlite3` from dependencies**

Edit `package.json` — delete `better-sqlite3` and `@types/better-sqlite3` entries from `dependencies` / `devDependencies`.

```bash
npm uninstall better-sqlite3 @types/better-sqlite3
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove in-memory queue and better-sqlite3"
```

---

## Task 11: Worker setup docs and PM2 wiring

**Files:**
- Create: `worker/README.md`

- [ ] **Step 1: Write `worker/README.md`**

```markdown
# Prism Worker

The worker polls Turso for pending translation rows and processes them using
the LLM on this machine. It is separate from the Vercel-hosted Next.js app —
the app just writes `pending` rows to the DB.

## First-time setup

1. Install Node.js 20+ and this project's dependencies:
   ```
   npm install
   ```
2. Copy `.env.worker.example` to `.env.worker` and fill in:
   - `TURSO_DATABASE_URL` — the Turso URL (same value as Vercel's env var)
   - `TURSO_AUTH_TOKEN` — the Turso auth token
   - `LLM_PROVIDER` — typically `ollama`
   - `LLM_PROVIDER_BASE_URL` — e.g. `http://localhost:11434/v1`
   - `LLM_MODEL` — the model you run locally

3. Make sure your LLM is running (e.g. `ollama serve`).

## Running in the foreground (for testing)

```
npm run worker
```

Leaves the worker attached to the terminal. Ctrl+C stops it cleanly.

## Running in the background (production)

Uses PM2, which auto-restarts on crash and on machine reboot.

First time only:
```
npm install -g pm2
npm run worker:pm2
pm2 save
pm2 startup   # follow the printed instructions to enable boot-start
```

Check status:
```
pm2 status
pm2 logs prism-worker
```

Stop / restart:
```
pm2 stop prism-worker
pm2 restart prism-worker
```

## Running on a different machine

No special setup. Copy the repo (or just `worker/` + `src/` + `package.json`
+ `drizzle/` + `tsconfig.json`), install deps, fill in `.env.worker`, start
the worker. Multiple machines can run workers simultaneously against the same
Turso DB; the atomic claim (`UPDATE ... RETURNING`) prevents duplicate
processing.

## Switching LLM backends

Edit `.env.worker`:
- Ollama → llama.cpp server: change `LLM_PROVIDER_BASE_URL`
- Local → OpenAI: change `LLM_PROVIDER=openai` and set `LLM_API_KEY`

Restart the worker (`pm2 restart prism-worker`) to pick up changes.
```

- [ ] **Step 2: Commit**

```bash
git add worker/README.md
git commit -m "docs: worker setup instructions"
```

---

## Task 12: Full local smoke test

Not a code change — a gate. Run the full flow end-to-end before declaring the migration done.

- [ ] **Step 1: Fresh local state (optional, to mimic the cloud "empty start")**

If you want to test from zero:
```bash
rm data/db.sqlite data/db.sqlite-wal data/db.sqlite-shm
rm -rf data/uploads data/covers data/exports
```

Then:
```bash
npm run db:migrate
```

- [ ] **Step 2: Start app + worker**

Terminal A: `npm run dev`
Terminal B: `npm run worker`

- [ ] **Step 3: Admin flow**

1. Sign in with the admin email
2. Upload an EPUB — confirm pricing dialog does NOT appear (admin bypass)
3. Click Translate — confirm worker picks up the jobs (watch Terminal B logs)
4. Open the book's read page — confirm translations display
5. Delete the book — confirm files cleaned up under `data/`

- [ ] **Step 4: Regular user flow**

1. Sign out, sign in with a non-admin account
2. Upload an EPUB — confirm pricing dialog appears
3. With 0 credits, click "Top up" in pricing dialog — confirm it opens the top-up modal stacked above
4. Top up some credits, close modal
5. Back in pricing dialog, click Buy on a tier — confirm purchase and credit deduction
6. Confirm only purchased chapters get translated by the worker

- [ ] **Step 5: Cancellation flow**

1. Queue translations on a book with many chapters
2. Before worker finishes, click Cancel on the book card
3. Confirm pending rows flip to `cancelled` and worker stops touching them

- [ ] **Step 6: Worker restart mid-flight**

1. Start translating
2. Kill the worker (Ctrl+C in Terminal B)
3. Restart: `npm run worker`
4. Confirm the worker resets stuck `processing` rows back to `pending` (logged on startup) and resumes

- [ ] **Step 7: Verify no regression in provider test**

```
npm run test
```

The existing `src/lib/llm/__tests__/provider.test.ts` must still pass.

- [ ] **Step 8: Commit — only if there are unrelated drift fixes**

If the smoke test uncovered bugs, fix them as additional commits. Don't bundle unrelated changes into the main migration commits.

---

## Task 13: Deploy to Vercel (user-executed, not agent-executed)

Leave this task for the user to run interactively. The plan here documents the sequence; agents should stop after Task 12.

Steps (user runs these):

1. **R2 bucket**: In Cloudflare dashboard → R2 → Create bucket `prism-files`.
2. **Turso DB**: Confirm `libsql://prism-dizzydog.aws-ap-northeast-1.turso.io` is reachable with the auth token.
3. **Vercel import**: Import this repo → fill 11 env vars from `.env.example` using actual production values.
4. **Clerk**: In Clerk dashboard, add Vercel production domain to Allowed Origins.
5. **Deploy**: Vercel → Deploy. Build runs `npm run db:migrate` (applies schema to Turso), then `next build`.
6. **Start worker on your machine**: `npm run worker:pm2` (then `pm2 save` + `pm2 startup`).
7. **Smoke test the prod URL**: repeat Task 12's flows against the live deployment.

---

## Done criteria

- [ ] `npm run build` passes with no errors
- [ ] `npm run test` passes
- [ ] Local smoke test (Task 12) passes end-to-end
- [ ] No imports reference `better-sqlite3`, `translation-queue`, or `translate/resume`
- [ ] Worker runs as a supervised PM2 process
- [ ] Vercel build succeeds and live URL serves the app
- [ ] Uploading, translating, and reading a book works on the live URL
