# AI Translation Storage and Write Optimization Design

## Status

Approved for implementation planning on 2026-07-24.

This design does not authorize a production migration, a production dedupe, or
starting `prism-worker`. Those remain explicit operator actions.

## Goal

Make Codex and Claude translation runs safer, more consistent, auditable, and
cheaper in Turso round trips while preserving the hosted reader's current
contract:

```text
paragraphs -> translations -> hosted reader
```

`translations.text` remains the canonical text rendered by the website. New
tables record execution and revision history around that canonical row.

## Current Evidence

Read-only production checks on 2026-07-24 found:

- `done=117521`
- `pending=28255`
- `failed=1160`
- `processing=0`
- `9330` duplicate `(paragraph_id, lang)` groups
- `9330` extra translation rows
- `8921` duplicate groups with no completed translation
- `287` groups with exactly one non-empty completed translation
- `122` groups with multiple non-empty completed translations
- `105` groups whose completed texts conflict
- duplicate groups split evenly: `4665` English and `4665` Chinese
- pending source text: about `1,060,328` characters across only `76`
  chapter/language groups

The duplicate evidence means a unique index cannot be added as the first
migration. Conflict selection must not be inferred from model name or update
time.

## Problems To Solve

1. `translations` is both queue state and final content, with no revision
   history.
2. There is no uniqueness guarantee for `(paragraph_id, lang)`.
3. Worker startup resets every `processing` row, which relies on exactly one
   Worker and can steal live work.
4. FIFO claims can mix books, chapters, and target languages in one model
   batch.
5. Claude batch persistence performs per-row updates and repeated chapter
   aggregate checks.
6. Codex has no batch provider, so it starts one CLI process per paragraph.
7. Batch parsing is all-or-nothing; one malformed item can fail valid items.
8. Result validation is mainly structural and does not protect against empty,
   source-copy, explanatory, or wrong-language output.
9. Replacing `translations.text` destroys the prior result and makes model
   comparison or rollback difficult.
10. Enqueue and book import are separate translation insert paths and both must
    honor the eventual uniqueness invariant.

## Non-Goals

- Do not replace Turso.
- Do not change the website chapter response shape in the first rollout.
- Do not let Codex or Claude write SQL directly.
- Do not add a local-LLM fallback.
- Do not implement general distributed autoscaling.
- Do not build a human translation editor in this phase.
- Do not automatically pick winners for conflicting completed translations.

## Invariants

- The Worker is the only component that claims and commits model output.
- Codex and Claude return structured candidates only.
- `paragraphs.source_text` is immutable during translation.
- A canonical row is updated only while owned by the current lease holder.
- A result is never activated unless its source hash still matches.
- Valid items in a partially bad batch may commit; bad items are isolated.
- Existing `done` rows are not overwritten unless a separately authorized
  retranslation explicitly targets them.
- Website-visible status values remain `pending`, `processing`, `done`, and
  `failed`.
- Production migration, dedupe apply, unique-index rollout, and real Worker
  start each require explicit approval.

## Target Data Model

### Existing `translations`

Keep all current columns and add:

```text
claimed_by       TEXT NULL
lease_expires_at TEXT NULL
```

`claimed_by` identifies the Worker instance. `lease_expires_at` allows only
expired work to be reclaimed. No new website-visible status is needed.

### New `translation_runs`

One row describes one authorized Worker execution:

```text
id                TEXT PRIMARY KEY
provider          TEXT NOT NULL
model             TEXT NOT NULL
reasoning_effort  TEXT NULL
prompt_version    TEXT NOT NULL
worker_id         TEXT NOT NULL
status            TEXT NOT NULL  -- running | stopped | completed | failed
started_at        TEXT NOT NULL
finished_at       TEXT NULL
claimed_count     INTEGER NOT NULL DEFAULT 0
done_count        INTEGER NOT NULL DEFAULT 0
failed_count      INTEGER NOT NULL DEFAULT 0
```

The run row provides an audit boundary for provider/model/prompt changes and
operator-approved run windows.

### New `translation_attempts`

One row preserves one generated, rejected, failed, imported, or superseded
candidate:

```text
id                     TEXT PRIMARY KEY
translation_id         TEXT NOT NULL
run_id                 TEXT NULL
legacy_translation_id  TEXT NULL
provider               TEXT NULL
model                  TEXT NULL
reasoning_effort       TEXT NULL
prompt_version         TEXT NOT NULL
source_hash            TEXT NOT NULL
text                   TEXT NOT NULL DEFAULT ''
status                 TEXT NOT NULL
quality_codes          TEXT NULL       -- JSON array
error_message          TEXT NULL
tokens_used            INTEGER NULL
is_active              INTEGER NOT NULL DEFAULT 0
created_at             TEXT NOT NULL
```

Attempt status values:

```text
accepted | rejected | failed | superseded | imported
```

Indexes:

- `translation_attempts(translation_id, created_at)`
- `translation_attempts(run_id)`
- partial unique index on `translation_attempts(translation_id)` where
  `is_active = 1`

The website continues reading `translations.text`. Activating an attempt and
copying its text/metadata into the canonical row occur in the same write
transaction.

## Migration Sequence

### Migration 0013: Additive and Compatible

`0013_translation_execution.sql`:

- add `claimed_by` and `lease_expires_at`
- create `translation_runs`
- create `translation_attempts`
- create supporting indexes

It must not delete data and must not create the translation uniqueness index.
Old application code can ignore the additive schema.

### Integrity Audit and Controlled Cleanup

Add a read-only-by-default audit/cleanup tool. It creates:

```text
data/translation-integrity-report.json
data/translation-conflict-decisions.json
```

Both remain gitignored.

Duplicate policy:

| Duplicate shape | Automatic action |
| --- | --- |
| No completed candidate | Keep the oldest pending canonical row; archive/remove extras |
| Exactly one non-empty completed candidate | Keep that completed row; archive/remove extras |
| Multiple completed candidates with identical text | Keep the newest metadata row; archive all candidates |
| Multiple completed candidates with different text | Stop and require a decisions-file survivor ID |

Before deleting a duplicate row, preserve its text, model, provider, error,
tokens, timestamps, and legacy row ID in `translation_attempts`.

Apply mode must:

- require an explicit `--apply`
- refuse while any translation is `processing` or has an unexpired lease
- verify the decisions file matches the current group membership
- use bounded write batches
- be idempotent
- re-run the duplicate report at the end
- stop unless duplicate count reaches zero

Claude must implement and test this tool but must not run production apply.

### Migration 0014: Enforce Uniqueness

Only after a production audit reports zero duplicate groups:

```sql
CREATE UNIQUE INDEX `idx_translations_paragraph_lang`
ON `translations` (`paragraph_id`, `lang`);
```

Before production `0014`, update both insertion paths:

- `src/lib/translate/enqueue.ts`
- `src/app/api/books/import/route.ts`

They must normalize/deduplicate input and handle conflict without replacing a
completed canonical translation.

Because `npm run build` runs migrations, no build or migration command may use
the production URL while an unapplied cleanup/index migration is under
development. Tests must inject a temporary `file:` database URL.

## Lease-Based Claiming

Create a dedicated Worker claim module instead of keeping raw SQL in
`worker/index.ts`.

Worker ID:

```text
<hostname>:<pid>:<random-uuid>
```

Claim behavior:

1. Select the oldest eligible seed row.
2. Join through paragraph/chapter/book metadata.
3. Claim only rows from the seed's chapter and target language.
4. Order by paragraph sequence.
5. Apply `WORKER_BATCH_SIZE`.
6. Set `processing`, `claimed_by`, and `lease_expires_at` atomically.
7. Return enough metadata to build the model request without a second
   per-row query.

Eligible means:

```text
status = pending
OR
(status = processing AND lease_expires_at < now)
```

The Worker must no longer reset every `processing` row on startup.

Lease writes and final result writes include:

```text
WHERE id = ? AND status = 'processing' AND claimed_by = ?
```

A heartbeat renews all IDs in one in-flight batch. The default lease must be
comfortably longer than the CLI timeout; suggested defaults:

```env
WORKER_LEASE_MS=600000
WORKER_LEASE_HEARTBEAT_MS=60000
```

This phase remains operationally single-Worker. Leases remove unsafe recovery
behavior and prepare for future multi-Worker support without claiming that
distributed scheduling is complete.

## Chapter-Aware Batch Contract

One model call contains one book, one chapter, one source language, and one
target language:

```json
{
  "bookTitle": "...",
  "chapterTitle": "...",
  "sourceLang": "ja",
  "targetLang": "zh",
  "items": [
    { "id": "...", "seq": 10, "text": "..." }
  ]
}
```

Output:

```json
{
  "translations": [
    { "id": "...", "text": "..." }
  ]
}
```

Rules:

- preserve input IDs exactly
- return at most one item per ID
- no unknown IDs
- no Markdown or explanation
- keep items in source order
- use book/chapter metadata only for consistency, never as output

Implement the same contract for Claude and Codex. Codex must gain
`translateBatch()` rather than falling back to many simultaneous
`runTranslation()` calls.

## Validation and Partial Success

Validation has two levels.

### Hard Rejection

- unknown or duplicate ID
- empty text
- exact or normalized source copy
- Markdown fence or obvious explanatory prefix
- model refusal/error text
- stale source hash

### Warning, Not Automatic Rejection

- unusual source/target length ratio
- target-language heuristic is uncertain
- retained Japanese proper nouns in Chinese/English

Language heuristics should be conservative. False rejection is worse than a
review warning for literary text.

The executor converts output into per-item results:

```text
accepted[] | rejected[] | missing[]
```

Accepted items commit even when siblings are rejected. Missing/rejected items
may be retried in a smaller batch. Whole-batch invalid JSON uses bounded binary
split retry:

- maximum split depth: 4
- no provider fallback unless explicitly configured
- stop at one item and record `invalid_output`

## Batched Persistence

Create a persistence helper that uses:

```ts
client.batch(statements, "write")
```

For each accepted item, one transaction must:

1. verify lease ownership and source hash
2. clear prior active attempt
3. insert the accepted active attempt
4. update canonical `translations.text/status/model/tokens/error/provider`
5. clear lease fields

Rejected/finally failed items insert a non-active attempt, set canonical
failure metadata, and clear the owned lease.

After a batch commits:

- collect distinct chapter IDs
- run one grouped aggregate query for all affected chapters
- batch the resulting chapter status updates

Do not call `checkChapterDone()` once per translation row.

## Run Lifecycle

At Worker start after configuration validation:

1. create `translation_runs` as `running`
2. log run ID, provider, model, prompt version, and Worker ID
3. attach every attempt to that run
4. increment counters in bounded batches
5. mark `stopped`, `completed`, or `failed` during shutdown

No secret, prompt body, source text, or translated text is written to logs.

## Rollout Gates

### Gate A: Development

- temporary local file database only
- focused tests and typecheck pass
- no production migration
- no production Worker

### Gate B: Additive Schema

- explicit user approval
- backup/restore point confirmed
- apply `0013`
- old reader and API smoke pass

### Gate C: Duplicate Cleanup

- Worker stopped
- audit report regenerated
- all 105 current conflict groups have explicit decisions
- dry-run summary reviewed
- explicit user approval for `--apply`
- post-cleanup duplicate count is zero

### Gate D: Unique Index

- enqueue and import conflict behavior deployed/tested
- explicit approval
- apply `0014`
- concurrent enqueue and import regression tests pass

### Gate E: Translation Canary

- one provider only, no local fallback
- one chapter/language group
- Chinese and English samples reviewed
- run history, attempts, leases, chapter status, and website display verified

## Backout

- Stop the Worker; unexpired leases prevent another owner from overwriting.
- Before `0014`, old code can ignore additive `0013` fields/tables.
- After `0014`, keep the unique index; remove it only if a proven compatibility
  issue requires an explicit migration.
- Canonical text can be restored from an earlier accepted attempt in one
  transaction.
- Never restore by deleting attempts; history is append-only except controlled
  duplicate migration.

## Success Criteria

- zero duplicate `(paragraph_id, lang)` groups before unique-index rollout
- no full-table `processing -> pending` reset
- every model result has run/provider/model/prompt/source-hash traceability
- Codex and Claude both support chapter-aware batch translation
- one malformed item does not fail valid siblings
- one Turso write batch per model result batch
- chapter completion checked once per affected chapter set, not per row
- website reads continue without response-shape changes
- no production mutation occurs without explicit approval
