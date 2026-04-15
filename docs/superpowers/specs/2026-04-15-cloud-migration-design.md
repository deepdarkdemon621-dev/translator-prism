# Cloud Migration Design

**Date:** 2026-04-15
**Status:** Approved — ready for implementation plan

## Goal

Deploy Prism to the public internet so it can be used from any browser, while keeping translation work on user-owned machines (to use the local LLM and avoid paid API costs). Existing local data is discarded (fresh start); Clerk accounts are preserved (unaffected by migration).

## Architecture

Three independent processes, communicating only through Turso:

```
Browser ──HTTP──> Vercel (Next.js, stateless)
                    ├──libsql──> Turso (DB)
                    └──S3 API──> Cloudflare R2 (files)

User's machine (always-on):
  Worker process ──libsql──> Turso (polls pending)
                 └──HTTP───> localhost LLM
```

**Key property:** Vercel never calls the LLM. It writes `pending` rows; worker picks them up. This eliminates the originally-planned Cloudflare Tunnel — worker makes an **outbound** connection to Turso, so user's machine needs no public IP or port forward.

**Switching LLM machines:** new machine runs worker with same Turso credentials. No Vercel reconfig. Multiple machines can run workers in parallel (atomic SQL claim prevents double-processing).

## Scope — In

1. DB driver swap: `better-sqlite3` → `@libsql/client`; add `await` to all ~150 call sites.
2. Storage: add `R2Storage` implementation using AWS S3 SDK; select via `STORAGE_DRIVER` env.
3. Queue: delete in-memory `TranslationQueue` singleton and `resumePendingTranslations` instrumentation hook; replace with worker process that polls Turso.
4. Worker: new `worker/` directory with main loop, graceful shutdown, and PM2 / Windows service instructions.
5. Transaction hardening: wrap bulk inserts in `src/app/api/books/upload/route.ts` in a single libsql transaction (batch of 500 statements max).
6. Export streaming: rewrite `src/lib/export/exporter.ts` to stream ZIP directly to R2 `openWriteStream()` instead of buffering full book in memory.
7. Migrator: replace drizzle better-sqlite3 migrator with libsql migrator; move invocation out of `instrumentation.ts` cold-start path (run in Vercel build step via `npm run db:migrate` in `package.json` build).
8. Env plumbing: 11 Vercel env vars, 4 worker env vars; `.env.example` updated.

## Scope — Out

- Data migration from local SQLite/filesystem to Turso/R2 (user opted for fresh start).
- Automated tests (project has no test infra; not the moment to add).
- Dual-driver abstraction (libsql `file:` URL natively handles local dev; single codepath).
- Cloudflare Tunnel (architectural pivot made it unnecessary).
- Translation job prioritization, retries beyond what already exists, or dead-letter queues.
- Observability / metrics / error reporting services.
- Any refactor unrelated to cloud readiness (queue abstraction, repo layer, file splitting).

## Component Design

### DB Layer (`src/lib/db/`)

- `src/lib/db/index.ts`: construct `@libsql/client` from `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`. File URL supported natively — `file:./data/db.sqlite` works for local dev.
- All 26 files using the db client: mechanical `await` addition on `.get()`, `.all()`, `.run()`, `.values()`. TypeScript compiler enforces completeness.
- Transactions: rewrite `db.transaction(fn)()` synchronous form to `await db.transaction(async (tx) => ...)` async form. Affects ~5 sites (upload, enqueue, cancel, export, migration).

### Storage Layer (`src/lib/storage.ts`)

- Existing abstraction (`getUploadsStorage`, `getCoversStorage`, `getExportsStorage`) keeps its interface. Call sites don't change.
- Add R2 implementation of the same interface (`put`, `get`, `delete`, `openWriteStream`) using `@aws-sdk/client-s3` against the R2 S3-compatible endpoint. File layout — single file or split module — left to implementer.
- `STORAGE_DRIVER` env selects backend (`fs` default, `r2` in prod).
- File keys stay unchanged (e.g. `uploads/<bookId>.epub`, `covers/<bookId>.jpg`). R2 uses same keys as object names.

### Worker (`worker/`)

- `worker/index.ts`: main loop. Every 2s: `UPDATE translations SET status='processing' WHERE status='pending' ORDER BY queued_at LIMIT 1 RETURNING *`; if row returned, call LLM, write result back.
- Reuses existing translation logic from `src/lib/queue/translation-queue.ts` extracted into a pure function `translateParagraph(input) → output` that both old queue and worker can call — then old queue is deleted.
- Worker imports DB client and LLM client from `src/lib/` — single source of truth, no code duplication between Next.js and worker.
- `worker/pm2.config.cjs` + `docs/worker-setup.md`: document how to auto-start as a service on Windows.
- Graceful shutdown: on SIGINT, finish the in-flight paragraph, then exit (don't leave rows stuck in `processing`).

### Instrumentation (`src/instrumentation.ts`)

- Remove `migrate()` call (runs in build step now).
- Remove `resumePendingTranslations()` call (worker handles this on its own startup by finding rows where `status='processing'` and resetting to `pending`).
- File may become effectively empty — delete if so.

### Environment

Vercel (11 vars):
- `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `ADMIN_EMAILS`
- `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
- `STORAGE_DRIVER=r2`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`

Worker `.env.worker` (4 vars):
- `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
- `LLM_PROVIDER_BASE_URL`, `LLM_MODEL`

Local dev `.env.local` (unchanged experience):
- `TURSO_DATABASE_URL=file:./data/db.sqlite`
- `TURSO_AUTH_TOKEN=` (empty, libsql accepts)
- `STORAGE_DRIVER=fs`
- Clerk vars as today

Local dev translation: run `npm run worker` in a second terminal. Worker polls the local SQLite file the same way it polls Turso. No separate inline codepath.

## Deployment Flow

1. R2 console: create bucket `prism-files`.
2. Clerk dashboard: add Vercel production domain to allowed origins.
3. Vercel: import GitHub repo, fill 11 env vars, deploy. Build step runs `npm run db:migrate` against Turso.
4. User's machine: clone repo (or copy worker-only subset), fill `.env.worker`, `npm run worker`, or register with PM2.
5. Smoke test: sign in → upload EPUB → verify pricing dialog → top up → purchase → verify worker picks up translations → verify read page.

## Rollback

Local dev remains fully functional on the same branch (different env vars). If Vercel deployment misbehaves, user keeps using local as before while fixes land.

## Risks

| Risk | Symptom | Mitigation |
|---|---|---|
| libsql transaction semantics differ from better-sqlite3 | Upload route errors on bulk insert | Explicit rewrite and manual verification of all ~5 transaction sites |
| Turso per-transaction statement limit (~1000) | Large EPUB upload fails | Batch inserts in chunks of 500 |
| R2 eventual consistency for `HEAD` probes | Cover 404s shortly after upload | Use `GetObject` and treat NotFound as missing; avoid `HEAD`-only checks |
| Clerk test keys limited to 1000 MAU | Fine for test phase | Document upgrade to prod keys when scaling |
| Vercel cold start + Turso handshake (~500ms) | First request slow | Accept — single-user app |
| Worker process crash unnoticed | Translations stall silently | PM2 auto-restart + log file; user checks worker terminal |
| Parallel workers racing on same job | Same paragraph translated twice (wasted cost) | Atomic `UPDATE ... RETURNING` claim pattern |

## Work Estimate

Roughly one engineer-day, split:
- DB driver swap + await propagation: 2–3h
- R2 storage implementation: 1h
- Worker + PM2: 2h
- Transaction hardening + export streaming: 1h
- Deployment debugging: 1h
