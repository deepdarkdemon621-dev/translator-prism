# Turso Row Read Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Turso row-read usage during background translation without changing queued/done/failed task semantics.

**Architecture:** Fix the hot worker claim query with a covering index that matches `WHERE status = 'pending' ORDER BY created_at LIMIT 1`. Replace the per-translation chapter status N+1 scan with one aggregate query that preserves the existing status rules. Keep progress UI manual-refresh only and add diagnostics so future read spikes can be explained from query plans.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM, libSQL/Turso, SQLite indexes, Vitest.

---

## Evidence Summary

- Current Turso data: `translations=25,908`, `done=18,327`, `pending=7,581`.
- Worker claim query in `worker/index.ts` filters on `status` but orders by `created_at`.
- Existing index `idx_translations_status_updated(status, updated_at)` does not satisfy that ordering.
- `EXPLAIN QUERY PLAN` currently reports `USE TEMP B-TREE FOR ORDER BY` for worker claims.
- Approximate claim-query scan volume for the current month: `(25,908 + 7,581) / 2 * 18,327 ~= 306M`, matching the observed `276M` row reads.
- `/progress` being open can add reads if an older deployed build still polls every 5 seconds. Current local `src/app/progress/page.tsx` fetches once on mount and on manual refresh only.

## Status Semantics To Preserve

- `pending`: queued and claimable by the worker.
- `processing`: claimed by the worker.
- `done`: successfully translated.
- `failed`: terminal until retry resets it to `pending`.
- `checkChapterDone(chapterId)` must keep current behavior:
  - If at least one translation exists and every translation for the chapter is `done`, set chapter status to `done`.
  - If any translation is `failed` and none are `pending` or `processing`, set chapter status to `error`.
  - Otherwise leave chapter status unchanged.
- Retry failed translations must keep working because it only resets rows from `failed` to `pending`.
- Worker crash recovery must keep working because it only resets rows from `processing` to `pending`.

## File Structure

- Modify: `drizzle/0010_translation_claim_index.sql` or the next generated migration filename.
  Adds a covering index for worker claim order.
- Modify: `drizzle/meta/_journal.json` and snapshot metadata if using `drizzle-kit generate`.
  Tracks the migration.
- Modify: `src/lib/chapter-status.ts`.
  Replaces N+1 status reads with one aggregate query.
- Create: `src/lib/__tests__/chapter-status.test.ts`.
  Covers status transitions and non-transition cases.
- Optional create: `scripts/check-turso-hotspots.mjs`.
  Runs row counts and `EXPLAIN QUERY PLAN` for known hot queries.
- Verify only: `src/app/progress/page.tsx`.
  Confirm there is no `setInterval`/auto-refresh in the deployed code path.

---

### Task 1: Add Worker Claim Covering Index

**Files:**
- Create: `drizzle/0010_translation_claim_index.sql`

- [ ] **Step 1: Read local Next.js route handler docs before touching API files**

Run:

```powershell
Get-Content -Raw .\node_modules\next\dist\docs\01-app\01-getting-started\15-route-handlers.md
```

Expected: local Next.js 16 route-handler documentation opens. No code changes in this step.

- [ ] **Step 2: Add migration**

Create `drizzle/0010_translation_claim_index.sql`:

```sql
-- Worker hot path: claim the oldest pending translation.
-- Covers WHERE status='pending' ORDER BY created_at LIMIT 1 and returns id
-- without building a temp sort tree.
CREATE INDEX IF NOT EXISTS `idx_translations_status_created_id`
ON `translations` (`status`, `created_at`, `id`);
```

If using Drizzle metadata generation, run the project-standard migration generation command instead of manually editing metadata. If manually adding the SQL file, update `drizzle/meta/_journal.json` with the next `idx`, `when`, and `tag` matching the filename.

- [ ] **Step 3: Apply migration locally/staging**

Run:

```powershell
npm run db:migrate
```

Expected: `Migrations complete.`

- [ ] **Step 4: Verify the claim query plan**

Run:

```powershell
@'
import { config } from "dotenv";
import { createClient } from "@libsql/client";
config({ path: ".env.worker" });
config({ path: ".env.local" });
config();
const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});
const res = await client.execute(`EXPLAIN QUERY PLAN UPDATE translations
SET status = 'processing', updated_at = datetime('now')
WHERE id = (
  SELECT id FROM translations
  WHERE status = 'pending'
  ORDER BY created_at
  LIMIT 1
)
RETURNING id`);
console.log(JSON.stringify(res.rows, null, 2));
client.close();
'@ | npx tsx -
```

Expected: plan uses `idx_translations_status_created_id` and does not include `USE TEMP B-TREE FOR ORDER BY`.

- [ ] **Step 5: Commit**

```powershell
git add drizzle
git commit -m "perf: index translation claim query"
```

---

### Task 2: Replace Chapter Status N+1 Reads With One Aggregate

**Files:**
- Modify: `src/lib/chapter-status.ts`
- Create: `src/lib/__tests__/chapter-status.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/__tests__/chapter-status.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as schema from "@/lib/db/schema";

let _testDb: ReturnType<typeof drizzle> | null = null;

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!_testDb) throw new Error("test DB not initialised");
    return _testDb;
  },
}));

describe("checkChapterDone", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeAll(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: "./drizzle" });
    _testDb = db;
  });

  afterAll(() => {
    _testDb = null;
    sqlite.close();
  });

  beforeEach(() => {
    db.delete(schema.translations).run();
    db.delete(schema.paragraphs).run();
    db.delete(schema.chapters).run();
    db.delete(schema.books).run();
    db.delete(schema.users).run();
  });

  function seedChapter(statuses: string[]) {
    const userId = randomUUID();
    const bookId = randomUUID();
    const chapterId = randomUUID();
    db.insert(schema.users).values({ id: userId, email: `${userId}@x`, isAdmin: 1 }).run();
    db.insert(schema.books).values({
      id: bookId,
      title: "T",
      author: "A",
      sourceLang: "ja",
      filePath: "/t.epub",
      totalChapters: 1,
      status: "parsed",
      userId,
    }).run();
    db.insert(schema.chapters).values({
      id: chapterId,
      bookId,
      index: 0,
      title: "C",
      sourceHtml: "<p>x</p>",
      status: "translating",
    }).run();
    for (const status of statuses) {
      const paragraphId = randomUUID();
      db.insert(schema.paragraphs).values({
        id: paragraphId,
        chapterId,
        seq: 0,
        sourceText: "x",
        sourceMarkup: "<p>x</p>",
        kind: "text",
      }).run();
      db.insert(schema.translations).values({
        id: randomUUID(),
        paragraphId,
        lang: "zh",
        status,
        text: status === "done" ? "y" : "",
      }).run();
    }
    return chapterId;
  }

  async function statusAfter(chapterId: string) {
    const { checkChapterDone } = await import("@/lib/chapter-status");
    await checkChapterDone(chapterId);
    return db.select().from(schema.chapters).where(eq(schema.chapters.id, chapterId)).get()?.status;
  }

  it("marks chapter done when every known translation is done", async () => {
    const chapterId = seedChapter(["done", "done"]);
    expect(await statusAfter(chapterId)).toBe("done");
  });

  it("marks chapter error when failures remain and no work is active", async () => {
    const chapterId = seedChapter(["done", "failed"]);
    expect(await statusAfter(chapterId)).toBe("error");
  });

  it("leaves chapter translating while pending work exists", async () => {
    const chapterId = seedChapter(["done", "failed", "pending"]);
    expect(await statusAfter(chapterId)).toBe("translating");
  });

  it("leaves chapter translating while processing work exists", async () => {
    const chapterId = seedChapter(["done", "failed", "processing"]);
    expect(await statusAfter(chapterId)).toBe("translating");
  });

  it("does not mark empty translation chapters done", async () => {
    const chapterId = seedChapter([]);
    expect(await statusAfter(chapterId)).toBe("translating");
  });
});
```

- [ ] **Step 2: Run tests to verify current behavior passes**

Run:

```powershell
npx vitest run src/lib/__tests__/chapter-status.test.ts
```

Expected: tests pass before optimization. These are regression tests, not intentionally failing tests, because the functional behavior already exists.

- [ ] **Step 3: Replace implementation with aggregate query**

Modify `src/lib/chapter-status.ts`:

```ts
import { getDb } from "./db";
import { chapters, paragraphs, translations } from "./db/schema";
import { eq, sql } from "drizzle-orm";

export async function checkChapterDone(chapterId: string) {
  const db = getDb();
  const stats = await db
    .select({
      total: sql<number>`COUNT(${translations.id})`,
      notDone: sql<number>`SUM(CASE WHEN ${translations.status} != 'done' THEN 1 ELSE 0 END)`,
      failed: sql<number>`SUM(CASE WHEN ${translations.status} = 'failed' THEN 1 ELSE 0 END)`,
      active: sql<number>`SUM(CASE WHEN ${translations.status} IN ('pending', 'processing') THEN 1 ELSE 0 END)`,
    })
    .from(translations)
    .innerJoin(paragraphs, eq(translations.paragraphId, paragraphs.id))
    .where(eq(paragraphs.chapterId, chapterId))
    .get();

  const total = Number(stats?.total ?? 0);
  const notDone = Number(stats?.notDone ?? 0);
  const failed = Number(stats?.failed ?? 0);
  const active = Number(stats?.active ?? 0);

  if (total > 0 && notDone === 0) {
    await db
      .update(chapters)
      .set({ status: "done", updatedAt: new Date().toISOString() })
      .where(eq(chapters.id, chapterId))
      .run();
  } else if (failed > 0 && active === 0) {
    await db
      .update(chapters)
      .set({ status: "error", updatedAt: new Date().toISOString() })
      .where(eq(chapters.id, chapterId))
      .run();
  }
}
```

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npx vitest run src/lib/__tests__/chapter-status.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run DB test suite**

Run:

```powershell
npx vitest run src/lib/db/__tests__ src/lib/__tests__/chapter-status.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/chapter-status.ts src/lib/__tests__/chapter-status.test.ts
git commit -m "perf: aggregate chapter status checks"
```

---

### Task 3: Lock In Manual Progress Refresh

**Files:**
- Verify: `src/app/progress/page.tsx`
- Optional modify: `src/app/progress/page.tsx`
- Optional modify: `src/components/GlobalQuotaBanner.tsx`

- [ ] **Step 1: Confirm no polling remains**

Run:

```powershell
rg -n "setInterval|setTimeout|fetchProgress\\(|/api/translation-progress|/api/system-status" src/app src/components
```

Expected:
- `src/app/progress/page.tsx` calls `fetchProgress()` on mount and button click only.
- No `setInterval` calls hit `/api/translation-progress`.
- `GlobalQuotaBanner` fetches `/api/system-status` once per path change, not on an interval.

- [ ] **Step 2: If deployed code still polls, remove interval**

Use this shape in `src/app/progress/page.tsx`:

```ts
useEffect(() => {
  fetchProgress();
}, [fetchProgress]);
```

Do not add an interval. Keep the existing Refresh button as the explicit update path.

- [ ] **Step 3: Verify build**

Run:

```powershell
npm run lint
npm run build
```

Expected: lint and build pass.

- [ ] **Step 4: Commit if code changed**

```powershell
git add src/app/progress/page.tsx src/components/GlobalQuotaBanner.tsx
git commit -m "perf: keep progress refresh manual"
```

---

### Task 4: Add Hot Query Diagnostics

**Files:**
- Create: `scripts/check-turso-hotspots.mjs`

- [ ] **Step 1: Add script**

Create `scripts/check-turso-hotspots.mjs`:

```js
import { config } from "dotenv";
import { createClient } from "@libsql/client";

config({ path: ".env.worker" });
config({ path: ".env.local" });
config();

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

async function show(label, sql) {
  const res = await client.execute(sql);
  console.log(`\n## ${label}`);
  console.log(JSON.stringify(res.rows, null, 2));
}

await show("row counts", `
SELECT 'books' table_name, COUNT(*) c FROM books
UNION ALL SELECT 'chapters', COUNT(*) FROM chapters
UNION ALL SELECT 'paragraphs', COUNT(*) FROM paragraphs
UNION ALL SELECT 'translations', COUNT(*) FROM translations
`);

await show("translation status", `
SELECT status, COUNT(*) c FROM translations GROUP BY status ORDER BY c DESC
`);

await show("worker claim plan", `EXPLAIN QUERY PLAN UPDATE translations
SET status = 'processing', updated_at = datetime('now')
WHERE id = (
  SELECT id FROM translations
  WHERE status = 'pending'
  ORDER BY created_at
  LIMIT 1
)
RETURNING id`);

await show("progress aggregate plan", `EXPLAIN QUERY PLAN SELECT c.book_id, COUNT(*)
FROM translations t
JOIN paragraphs p ON t.paragraph_id = p.id
JOIN chapters c ON p.chapter_id = c.id
GROUP BY c.book_id`);

client.close();
```

- [ ] **Step 2: Run diagnostics**

Run:

```powershell
node scripts/check-turso-hotspots.mjs
```

Expected:
- Worker claim plan uses `idx_translations_status_created_id`.
- Worker claim plan has no `USE TEMP B-TREE FOR ORDER BY`.
- Row counts match expected current database size.

- [ ] **Step 3: Commit**

```powershell
git add scripts/check-turso-hotspots.mjs
git commit -m "chore: add turso hotspot diagnostics"
```

---

### Task 5: Deploy Safely With Worker Running

**Files:**
- No source files.

- [ ] **Step 1: Pause or drain the worker if possible**

Preferred if using PM2:

```powershell
npx pm2 stop prism-worker
```

Expected: no new translations are claimed while migrations and code deploy happen.

- [ ] **Step 2: Apply DB migration**

Run:

```powershell
npm run db:migrate
```

Expected: migration completes. Creating the new index scans existing `translations` once, so it may add roughly current translation-row-count reads, but this is a one-time cost.

- [ ] **Step 3: Restart app/worker on the new code**

Run the deployment command for the app. Then restart worker:

```powershell
npx pm2 start worker/ecosystem.config.cjs
```

Expected: worker logs show normal startup. If any rows were left `processing`, current worker recovery resets them to `pending`.

- [ ] **Step 4: Verify no status regression**

Run:

```powershell
node scripts/check-progress.mjs
node scripts/check-turso-hotspots.mjs
```

Expected:
- `translations` statuses look sane: `pending` decreases, `done` increases, no unexpected mass `failed`.
- Worker claim plan still uses `idx_translations_status_created_id`.

