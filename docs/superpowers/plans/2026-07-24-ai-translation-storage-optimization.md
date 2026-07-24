# AI Translation Storage and Write Optimization Implementation Plan

> **For Claude:** Read `AGENTS.md`, `AI_TRANSLATION_GUIDE.md`, the three local
> AI memory files, and the companion design before editing. Work with the
> existing dirty Worker/LLM changes; do not reset, stash, overwrite, or
> reimplement them from `origin/master`.

**Companion design:**
`docs/superpowers/specs/2026-07-24-ai-translation-storage-optimization-design.md`

**Goal:** Add safe lease-based claiming, chapter-aware Codex/Claude batching,
validated partial success, Turso batched persistence, translation revision
history, and a controlled path to `(paragraph_id, lang)` uniqueness.

**Hard boundary:** Development uses a temporary local `file:` database. Do not
run `npm run db:migrate`, `npm run build`, a dedupe apply, or `prism-worker`
against production without a new explicit user instruction.

## Baseline Constraints

- Current HEAD is `e28907b`.
- Existing uncommitted Worker/LLM changes include Claude batch translation and
  window-only/no-local-fallback behavior. Preserve them.
- Production currently has `9330` duplicate translation keys and `105`
  conflicting completed-text groups.
- Migration `0013` is additive. Migration `0014` is a gated follow-up and must
  not reach production before dedupe reports zero.
- Follow TDD: write a failing focused test, run it to confirm RED, implement the
  smallest change, rerun GREEN, then broaden verification.
- Do not include Ollama/local LLM in examples, defaults, or fallback chains.

## Task 0: Establish a Safe Development Baseline

**Files:**

- Read only: current dirty files from `git status --short`
- Update locally: `AI_TASK_BOARD.md`, `AI_HANDOFF_SUMMARY.md`,
  `AI_SESSION_ENTRY.md`

1. Record `git status --short --branch` and `git diff --stat`.
2. List the exact pre-existing Worker/LLM files. Do not normalize line endings.
3. Run focused existing tests before editing:

```powershell
npx vitest run src/lib/llm/__tests__/cli-output.test.ts src/lib/llm/__tests__/cli-providers.test.ts src/lib/llm/__tests__/provider-chain.test.ts worker/__tests__/progress.test.ts worker/__tests__/schedule.test.ts
npx tsc --noEmit --pretty false
```

4. Create a temporary test database path under `data/` and inject it per
   command:

```powershell
$env:TURSO_DATABASE_URL='file:./data/translation-optimization-test.sqlite'
Remove-Item Env:TURSO_AUTH_TOKEN -ErrorAction SilentlyContinue
```

Do not persist this override into tracked env files.

**Stop if:** baseline failures overlap the planned files. Record unrelated
failures but do not fix them in this work.

## Task 1: Add Translation Execution Schema (Migration 0013)

**Files:**

- Create: `drizzle/0013_translation_execution.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/lib/db/schema.ts`
- Modify: `src/lib/db/__tests__/schema.test.ts`

1. Add failing schema tests for:
   - `translations.claimedBy`
   - `translations.leaseExpiresAt`
   - `translationRuns`
   - `translationAttempts`
   - one active attempt per translation
2. Run:

```powershell
npx vitest run src/lib/db/__tests__/schema.test.ts
```

3. Implement the additive schema exactly as described in the design.
4. Add indexes for attempt lookup, run lookup, lease claim lookup, and one
   active attempt per translation.
5. Update the Drizzle journal with `0013_translation_execution`.
6. Run migration only against the injected temporary file database.
7. Rerun schema tests and typecheck.

**Do not:** add the `(paragraph_id, lang)` unique index in `0013`.

## Task 2: Build Read-Only Integrity Audit

**Files:**

- Create: `src/lib/translation-integrity.ts`
- Create: `src/lib/__tests__/translation-integrity.test.ts`
- Create: `scripts/audit-translations.ts`
- Modify: `package.json`

1. Write failing tests for duplicate classification:
   - no completed candidate
   - exactly one completed candidate
   - multiple identical completed candidates
   - conflicting completed candidates
2. Define a deterministic report schema with counts, group key, candidate IDs,
   statuses, model/provider metadata, timestamps, and conflict flag.
3. Implement `npm run translations:audit` as read-only.
4. Default output:

```text
data/translation-integrity-report.json
data/translation-conflict-decisions.json
```

5. Redact credentials and avoid logging full novel text to stdout.
6. Add a test proving the audit performs no writes.
7. Verify against a temporary database fixture containing all four duplicate
   shapes.

**Production rule:** Claude may run the audit read-only only after confirming
the command has no write statements. It must not run cleanup apply.

## Task 3: Build Controlled Duplicate Cleanup

**Files:**

- Modify: `src/lib/translation-integrity.ts`
- Create: `src/lib/__tests__/translation-dedupe.test.ts`
- Create: `scripts/dedupe-translations.ts`
- Modify: `package.json`

1. Add RED tests for:
   - dry-run default
   - refusal when `processing` or an unexpired lease exists
   - simple pending duplicate survivor selection
   - one-done survivor selection
   - identical-done survivor selection
   - conflicting done group requires a decisions entry
   - stale decisions/group membership refusal
   - archival into `translation_attempts` before delete
   - idempotent second apply
2. Implement:

```powershell
npm run translations:dedupe -- --dry-run
npm run translations:dedupe -- --apply --decisions data/translation-conflict-decisions.json
```

3. Require `--apply`; never infer it.
4. Archive candidate metadata and legacy translation IDs before deleting
   duplicates.
5. Use bounded `client.batch(..., "write")` transactions.
6. Re-audit after apply and fail unless duplicate count is zero.
7. Test exclusively against temporary databases.

**Mandatory pause:** Do not run production `--apply`. Report that implementation
is ready and wait for explicit approval plus completed decisions.

## Task 4: Make All Insert Paths Uniqueness-Safe

**Files:**

- Modify: `src/lib/translate/enqueue.ts`
- Modify: `src/lib/translate/__tests__/enqueue.test.ts`
- Modify: `src/app/api/books/import/route.ts`
- Add or modify focused import tests
- Modify: `src/lib/db/schema.ts` only when migration 0014 is authorized

1. Add failing concurrent-enqueue tests proving one canonical row per
   `(paragraph_id, lang)`.
2. Add import tests for duplicate keys in one payload and conflicts with an
   existing `done` row.
3. Implement deterministic payload dedupe.
4. Use conflict-safe insert behavior that never replaces a completed
   translation.
5. Preserve existing reset behavior for explicitly retried non-done rows.
6. Run focused enqueue/import tests.

Do not create production migration `0014` yet. Test the intended unique index
against a temporary cleaned fixture using raw SQL.

## Task 5: Extract Lease-Based Chapter/Language Claiming

**Files:**

- Create: `worker/claim.ts`
- Create: `worker/__tests__/claim.test.ts`
- Modify: `worker/index.ts`
- Modify: `.env.worker.example`
- Modify: `worker/README.md`

1. Add RED tests for:
   - claim only `pending`
   - reclaim only expired `processing`
   - never claim an unexpired lease
   - one chapter and one target language per batch
   - paragraph sequence ordering
   - Worker ID and lease expiry written atomically
   - lease ownership required for renewal/release
2. Implement `claimTranslationBatch()` and lease heartbeat helpers.
3. Return joined book/chapter/paragraph metadata from the claim helper.
4. Remove full-table `resetStaleProcessing()`.
5. Add env defaults:

```env
WORKER_LEASE_MS=600000
WORKER_LEASE_HEARTBEAT_MS=60000
```

6. Ensure shutdown stops heartbeats and lets unfinished leases expire.
7. Keep operational guidance at one Worker until a separate multi-Worker
   design is approved.

## Task 6: Define One Chapter-Aware Batch Contract

**Files:**

- Modify: `src/lib/llm/types.ts`
- Modify: `src/lib/llm/cli-providers.ts`
- Modify: `src/lib/llm/cli-output.ts`
- Modify: corresponding LLM tests and fixtures

1. Add RED tests for the design's request/output JSON contract.
2. Include book title, chapter title, source language, target language, ID,
   paragraph sequence, and source text.
3. Preserve exact IDs and reject unknown/duplicate IDs.
4. Keep one provider call to one chapter and one target language.
5. Update Claude batch prompt without changing its auth isolation behavior.
6. Add `CodexCliProvider.translateBatch()` with the same contract.
7. Keep Codex `read-only`, `--ephemeral`, and no bypass.
8. Verify one Worker slot cannot fan out into many Codex processes.

## Task 7: Add Per-Item Validation and Bounded Split Retry

**Files:**

- Create: `src/lib/llm/translation-validation.ts`
- Create: `src/lib/llm/__tests__/translation-validation.test.ts`
- Modify: batch parsers/providers as needed

1. Add RED tests for all hard rejection and warning cases in the design.
2. Implement conservative validation returning:

```ts
{ accepted, rejected, missing, warnings }
```

3. Do not reject literary text solely on a probabilistic language detector.
4. Add bounded binary split retry for whole-batch invalid JSON:
   - max depth 4
   - no implicit provider fallback
   - final single-item failure becomes `invalid_output`
5. Prove valid siblings survive a malformed/missing item.

## Task 8: Add Run Lifecycle and Batched Persistence

**Files:**

- Create: `src/lib/translate/persist-batch.ts`
- Create: `src/lib/translate/__tests__/persist-batch.test.ts`
- Create: `src/lib/translate/run-lifecycle.ts`
- Create: `src/lib/translate/__tests__/run-lifecycle.test.ts`
- Modify: `src/lib/llm/executor.ts`
- Modify: `src/lib/chapter-status.ts`
- Modify: chapter status tests

1. Add RED tests proving:
   - accepted attempt and canonical update are atomic
   - prior active attempt becomes inactive
   - rejected attempt does not replace canonical text
   - stale source hash cannot commit
   - wrong lease owner cannot commit
   - lease fields clear on terminal result
   - one `client.batch(..., "write")` call per result batch
   - chapter status refresh runs once per distinct chapter set
2. Implement SHA-256 source hashes over UTF-8 source text.
3. Persist attempts and canonical updates through raw libSQL batch statements
   with parameter binding.
4. Replace per-row `checkChapterDone()` calls with grouped chapter refresh.
5. Create/finish one `translation_runs` row per Worker process.
6. Keep source text and translation text out of logs.

## Task 9: Integrate Worker Without Changing Website Reads

**Files:**

- Modify: `worker/index.ts`
- Modify: Worker progress/resilience tests
- Modify: `scripts/check-progress.mjs` or add a run-status script

1. Wire claim metadata -> provider request -> validation -> persistence.
2. Keep `translations.text/status` populated for existing API/reader code.
3. Ensure cancel/retry paths do not let an old lease owner overwrite state.
4. Add counters for accepted/rejected/missing items and current run ID.
5. Verify graceful shutdown and expired-lease recovery.
6. Do not start the real Worker.

## Task 10: Prepare Migration 0014 Behind a Production Gate

**Files:**

- Create only after approval/cleanup:
  `drizzle/0014_translation_paragraph_lang_unique.sql`
- Modify only then: `drizzle/meta/_journal.json`
- Modify only then: `src/lib/db/schema.ts`

Preconditions:

```text
duplicate_groups = 0
processing = 0
unexpired_leases = 0
enqueue/import uniqueness tests = PASS
production cleanup explicitly approved and completed
```

Migration:

```sql
CREATE UNIQUE INDEX `idx_translations_paragraph_lang`
ON `translations` (`paragraph_id`, `lang`);
```

Claude must stop before this task unless the user separately authorizes
production cleanup and unique-index rollout.

## Task 11: Documentation and Verification

**Files:**

- Update: `AI_TRANSLATION_GUIDE.md`
- Update: `worker/README.md`
- Update: `.env.worker.example`
- Update local AI memory files

Run with a temporary DB:

```powershell
npx vitest run src/lib/__tests__/translation-integrity.test.ts src/lib/__tests__/translation-dedupe.test.ts worker/__tests__/claim.test.ts src/lib/llm/__tests__/cli-output.test.ts src/lib/llm/__tests__/cli-providers.test.ts src/lib/llm/__tests__/translation-validation.test.ts src/lib/translate/__tests__/persist-batch.test.ts src/lib/translate/__tests__/run-lifecycle.test.ts src/lib/__tests__/chapter-status.test.ts
npx tsc --noEmit --pretty false
npx eslint worker src/lib/llm src/lib/translate scripts/audit-translations.ts scripts/dedupe-translations.ts
git diff --check
```

Also run the existing focused Worker/LLM suite. Full lint/test baseline blockers
must be reported separately rather than mixed into this feature.

## Commit Boundaries

Suggested commits after tests pass:

1. `feat(db): add translation run and attempt history`
2. `feat(worker): add lease-based chapter batch claims`
3. `feat(llm): validate Codex and Claude batch translations`
4. `feat(worker): batch translation persistence and chapter refresh`
5. `tools: add controlled translation integrity cleanup`
6. `docs: document optimized AI translation workflow`

Do not include unrelated dirty files by accident. Because existing Worker/LLM
changes are the base of this feature, inspect every staged hunk before commit.

## Definition of Done

- additive schema and all new modules pass on a temporary file database
- production cleanup tool is implemented but not applied
- current website read contract is unchanged
- no full-table processing reset remains
- Codex and Claude share one chapter-aware batch contract
- valid batch siblings commit independently
- canonical writes are lease- and source-hash-protected
- attempts and runs provide rollback/audit history
- migration 0014 remains blocked until production duplicate count is zero
- no production Worker, migration, dedupe, deployment, or push occurred without
  explicit user approval
