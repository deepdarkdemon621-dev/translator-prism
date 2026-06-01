# CLI Translation Provider Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional Claude Code/Codex CLI translation providers with automatic local LLM fallback and controlled failed-row retry.

**Architecture:** Keep `worker/index.ts` as the queue owner. Add probe-backed CLI parsers, timeout-safe CLI runners, provider-chain logic under `src/lib/llm/`, and an idle failed-row requeue step guarded by retry metadata.

**Tech Stack:** TypeScript, Node.js `child_process`, Drizzle/libSQL, Vitest, PM2 worker.

**Direction is one-way:** Claude Code/Codex -> Ollama. Disabled providers are re-enabled only by PM2 restart.

---

## File Structure

- Create: `src/lib/llm/__fixtures__/claude-cli-output.json`
  - Captured Claude CLI probe output.
- Create: `src/lib/llm/__fixtures__/codex-cli-output.jsonl`
  - Captured Codex JSONL probe output.
- Create: `src/lib/llm/cli-output.ts`
  - Parses and validates CLI text output (Claude) and JSONL event streams (Codex).
- Create: `src/lib/llm/cli-runner.ts`
  - Runs local commands with stdin, timeout, stdout/stderr capture, non-zero exit handling, and Windows shim resolution.
- Create: `src/lib/llm/cli-providers.ts`
  - Implements `ClaudeCodeCliProvider` and `CodexCliProvider`.
- Create: `src/lib/llm/provider-chain.ts`
  - Tries providers in order, enforces CLI provider concurrency, and maintains module-level disabled state.
- Modify: `src/lib/llm/factory.ts`
  - Builds single providers and provider chains from env/settings.
- Modify: `src/lib/llm/executor.ts`
  - Includes chain config in cache signature and records provider attempt metadata.
- Modify: `src/lib/llm/errors.ts`
  - Adds `invalid_output` and CLI quota/auth/budget/timeout patterns.
- Create: `drizzle/0011_translation_retry_metadata.sql`
  - Adds retry metadata columns and optionally backfills historical failed rows.
- Modify: `src/lib/db/schema.ts`
  - Adds retry metadata fields to `translations`.
- Create: `worker/failed-requeue.ts`
  - Requeues eligible failed rows when the worker is idle.
- Modify: `worker/index.ts`
  - Calls failed requeue only after pending is drained and no jobs are in flight.
- Add tests:
  - `src/lib/llm/__tests__/errors.test.ts`
  - `src/lib/llm/__tests__/cli-output.test.ts`
  - `src/lib/llm/__tests__/cli-runner.test.ts`
  - `src/lib/llm/__tests__/cli-providers.test.ts`
  - `src/lib/llm/__tests__/provider-chain.test.ts`
  - `worker/__tests__/failed-requeue.test.ts`

---

## Task 0: Probe Real CLI Output

**Files:**
- Create: `src/lib/llm/__fixtures__/claude-cli-output.json`
- Create: `src/lib/llm/__fixtures__/codex-cli-output.jsonl`
- Create: `docs/superpowers/specs/2026-06-01-cli-probe-notes.md`

- [ ] **Step 1: Probe Claude without `--bare`**

Run from project root:

```powershell
$prompt = 'Return exactly this JSON and nothing else: {"text":"hello"}'
$prompt | claude -p --output-format text --model sonnet --tools "" --no-session-persistence --json-schema '{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}'
```

Expected: stdout contains a parseable JSON object with `text`.

- [ ] **Step 2: Probe Claude with `--bare`**

Run:

```powershell
$prompt = 'Return exactly this JSON and nothing else: {"text":"hello"}'
$prompt | claude -p --output-format text --model sonnet --tools "" --no-session-persistence --bare --json-schema '{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}'
```

Expected: if this fails due to auth/session, record `CLAUDE_CODE_BARE=false` as the default in probe notes.

- [ ] **Step 3: Probe Codex without bypass**

Run:

```powershell
$prompt = 'Return exactly this JSON and nothing else: {"text":"hello"}'
$prompt | codex exec -s read-only --ephemeral --json -
```

Expected: command exits without interactive prompt and stdout is JSONL. If it blocks on approval, record that `CODEX_CLI_ALLOW_BYPASS=true` is required. Only pass `-m` when `CODEX_CLI_MODEL` is explicitly set; the 2026-06-01 probe showed `-m o3` is unsupported for the current ChatGPT-backed Codex account.

- [ ] **Step 4: Save fixtures**

Save the successful Claude output to:

```text
src/lib/llm/__fixtures__/claude-cli-output.json
```

Save the successful Codex output to:

```text
src/lib/llm/__fixtures__/codex-cli-output.jsonl
```

Record command outcomes and auth/bypass notes in:

```text
docs/superpowers/specs/2026-06-01-cli-probe-notes.md
```

## Task 1: Add Retry Metadata

**Files:**
- Create: `drizzle/0011_translation_retry_metadata.sql`
- Modify: `src/lib/db/schema.ts`

- [ ] **Step 1: Add migration**

Create `drizzle/0011_translation_retry_metadata.sql`:

```sql
ALTER TABLE `translations` ADD COLUMN `retry_count` integer DEFAULT 0 NOT NULL;
ALTER TABLE `translations` ADD COLUMN `last_provider` text;
ALTER TABLE `translations` ADD COLUMN `last_error_code` text;

UPDATE `translations`
SET `last_error_code` = 'unknown'
WHERE `status` = 'failed' AND `last_error_code` IS NULL;
```

- [ ] **Step 2: Update schema**

In `src/lib/db/schema.ts`, add these fields to `translations`:

```ts
retryCount: integer("retry_count").notNull().default(0),
lastProvider: text("last_provider"),
lastErrorCode: text("last_error_code"),
```

- [ ] **Step 3: Verify DB-related tests**

Run:

```powershell
npx vitest run src/lib/db
```

Expected: existing DB tests pass after migration/schema alignment.

## Task 2: Extend Error Classifier

**Files:**
- Modify: `src/lib/llm/errors.ts`
- Create: `src/lib/llm/__tests__/errors.test.ts`

- [ ] **Step 1: Add `invalid_output`**

Update the union:

```ts
export type LLMErrorCode =
  | "quota_exhausted"
  | "rate_limit"
  | "auth_error"
  | "model_not_found"
  | "network"
  | "invalid_output"
  | "unknown";
```

Update `parseErrorCode()` known list to include `"invalid_output"`.

- [ ] **Step 2: Add CLI patterns**

Add classifier branches:

```ts
if (
  lower.includes("budget exceeded") ||
  lower.includes("maximum budget") ||
  lower.includes("max budget") ||
  lower.includes("--max-budget-usd")
) {
  return { code: "quota_exhausted", friendly: "CLI budget exhausted; using local LLM fallback", raw };
}

if (
  lower.includes("login required") ||
  lower.includes("not authenticated") ||
  lower.includes("authentication required") ||
  lower.includes("please log in") ||
  lower.includes("unauthorized")
) {
  return { code: "auth_error", friendly: "CLI authentication failed; restart worker after fixing login", raw };
}

if (lower.includes("cli process timed out")) {
  return { code: "network", friendly: "CLI timed out; retrying with fallback provider", raw };
}

// CliOutputError.code is "invalid_output" but its .message is human-readable.
// Check the .code property, not the message string.
if ((err as { code?: string }).code === "invalid_output") {
  return { code: "invalid_output", friendly: "CLI returned invalid translation output", raw };
}
```

- [ ] **Step 3: Verify**

Run:

```powershell
npx vitest run src/lib/llm/__tests__/errors.test.ts
```

Expected: CLI patterns classify correctly and existing patterns still pass.

## Task 3: Add Probe-Backed CLI Output Parsers

**Files:**
- Create: `src/lib/llm/cli-output.ts`
- Create: `src/lib/llm/__tests__/cli-output.test.ts`

- [ ] **Step 1: Write parser tests from fixtures**

Test:

- `parseClaudeCliOutput()` extracts `text` from `src/lib/llm/__fixtures__/claude-cli-output.json`.
- `parseCodexCliOutput()` extracts `text` from `src/lib/llm/__fixtures__/codex-cli-output.jsonl`.
- Markdown fenced JSON is accepted if the JSON object is valid.
- Empty text throws `CliOutputError` with `code = "invalid_output"`.
- Non-JSON explanation throws `CliOutputError`.
- Codex JSONL with no assistant/final message throws `CliOutputError`.

- [ ] **Step 2: Implement parsers**

Implement:

```ts
export class CliOutputError extends Error {
  code = "invalid_output" as const;
}

export function parseClaudeCliOutput(stdout: string): string;
export function parseCodexCliOutput(stdout: string): string;
```

Implementation details:

- `parseClaudeCliOutput()` strips optional Markdown fences, parses JSON, and returns `text`.
- `parseCodexCliOutput()` parses each JSONL line, extracts text from the event shape observed in Task 0 fixtures, then parses the final assistant text as JSON.
- Parser helpers must reject empty `text`.

- [ ] **Step 3: Verify**

Run:

```powershell
npx vitest run src/lib/llm/__tests__/cli-output.test.ts
```

Expected: fixture-backed parser tests pass.

## Task 4: Add Timeout-Safe CLI Runner

**Files:**
- Create: `src/lib/llm/cli-runner.ts`
- Create: `src/lib/llm/__tests__/cli-runner.test.ts`

- [ ] **Step 1: Write runner tests**

Cover:

- Successful command returns stdout.
- Non-zero exit throws with stderr included.
- Timeout kills process and throws an error containing `"CLI process timed out"`.
- Windows resolver prefers `codex.cmd` over `codex.ps1` when command is `codex`.

- [ ] **Step 2: Implement Windows command resolution**

Expose:

```ts
export function resolveCliCommand(command: string, platform = process.platform): string;
```

Behavior:

- If command contains a slash, backslash, or extension, return it unchanged.
- On Windows with no extension, search `PATH` for `<command>.cmd`, then `<command>.exe`, then `<command>`.
- On non-Windows, return command unchanged.

- [ ] **Step 3: Implement runner**

Use `child_process.spawn` with:

- `shell: false`
- resolved command
- stdin prompt write then end
- stdout/stderr buffer capture
- timeout with `child.kill()`
- inherited `process.env`

Expose:

```ts
export interface CliRunOptions {
  command: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
  cwd?: string;
}

export async function runCli(options: CliRunOptions): Promise<{ stdout: string; stderr: string }>;
```

- [ ] **Step 4: Verify**

Run:

```powershell
npx vitest run src/lib/llm/__tests__/cli-runner.test.ts
```

Expected: runner tests pass without actually calling Claude/Codex.

## Task 5: Add Claude Code and Codex Providers

**Files:**
- Create: `src/lib/llm/cli-providers.ts`
- Create: `src/lib/llm/__tests__/cli-providers.test.ts`

- [ ] **Step 1: Write provider tests with mocked runner**

Cover:

- Claude provider includes `--bare` only when `CLAUDE_CODE_BARE=true`.
- Claude provider includes `--max-budget-usd` only when configured.
- Codex provider is disabled unless `CODEX_CLI_ENABLED=true`.
- Codex provider appends `--dangerously-bypass-approvals-and-sandbox` only when `CODEX_CLI_ALLOW_BYPASS=true`.
- Both providers return `tokensUsed: 0`.
- Codex omits `-m` unless `CODEX_CLI_MODEL` is configured.

- [ ] **Step 2: Implement `ClaudeCodeCliProvider`**

Use:

```text
claude -p --output-format text --model <model> --tools "" --no-session-persistence
```

Append:

- `--bare` when `CLAUDE_CODE_BARE=true`
- `--max-budget-usd <value>` when configured
- `--json-schema <schema>` when supported by the probe

Return:

```ts
{ text: translated, tokensUsed: 0, model: `claude-code:${model}` }
```

- [ ] **Step 3: Implement `CodexCliProvider`**

Use:

```text
codex exec [-m <model>] -s read-only --ephemeral --json -
```

Append:

```text
--dangerously-bypass-approvals-and-sandbox
```

only when `CODEX_CLI_ALLOW_BYPASS=true`.

Return:

```ts
{ text: translated, tokensUsed: 0, model: `codex:${model || "default"}` }
```

- [ ] **Step 4: Verify**

Run:

```powershell
npx vitest run src/lib/llm/__tests__/cli-providers.test.ts
```

Expected: provider command construction and parsing behavior pass with mocked runner.

## Task 6: Add Provider Chain, Typed Errors, and CLI Concurrency

**Files:**
- Create: `src/lib/llm/provider-chain.ts`
- Create: `src/lib/llm/__tests__/provider-chain.test.ts`

- [ ] **Step 1: Write provider-chain tests**

Cover:

- First provider success returns immediately.
- `quota_exhausted`, `auth_error`, and `model_not_found` disable a provider permanently for the current process.
- `network`, `rate_limit`, `invalid_output`, and `unknown` fall through without permanent disable.
- Module-level disabled set persists after chain reconstruction.
- Thrown final error is `ProviderChainError` with attempts, `finalProvider`, and `finalCode`.
- CLI concurrency limiter prevents two simultaneous calls to the same CLI provider.

- [ ] **Step 2: Implement typed chain error**

Implement:

```ts
export interface ProviderAttemptFailure {
  providerName: string;
  code: LLMErrorCode;
  message: string;
}

export class ProviderChainError extends Error {
  constructor(
    readonly attempts: ProviderAttemptFailure[],
    readonly finalProvider: string | null,
    readonly finalCode: LLMErrorCode,
  ) {
    super(`All providers failed: ${attempts.map((a) => `${a.providerName}:${a.code}`).join(", ")}`);
  }
}
```

- [ ] **Step 3: Implement provider chain**

Use module-level:

```ts
export const disabledProviders = new Set<string>();
```

Permanent disable codes:

```ts
const PERMANENT_DISABLE_CODES: LLMErrorCode[] = [
  "quota_exhausted",
  "auth_error",
  "model_not_found",
];
```

Throw `ProviderChainError` when all providers fail.

- [ ] **Step 4: Add concurrency limiter**

Use a small promise queue or semaphore per CLI provider name:

```ts
const providerConcurrency = new Map<string, Promise<void>>();
```

Default limits:

- `CLAUDE_CODE_CONCURRENCY=1`
- `CODEX_CLI_CONCURRENCY=1`

Keep local/Ollama concurrency governed by `WORKER_CONCURRENCY`.

- [ ] **Step 5: Verify**

Run:

```powershell
npx vitest run src/lib/llm/__tests__/provider-chain.test.ts
```

Expected: fallback, disable, typed error, and concurrency tests pass.

## Task 7: Wire Provider Chain into Factory and Executor

**Files:**
- Modify: `src/lib/llm/factory.ts`
- Modify: `src/lib/llm/executor.ts`

- [ ] **Step 1: Update factory**

Add:

```ts
export function buildProviderFromEnv(fallbackProvider: string, fallbackApiKey: string): LLMProvider;
```

Rules:

- No `TRANSLATION_PROVIDER_CHAIN`: keep existing `createProvider()` behavior.
- `claude-code`: only create when `CLAUDE_CODE_ENABLED=true`.
- `codex`: only create when `CODEX_CLI_ENABLED=true`.
- Unknown names throw clear config errors.

- [ ] **Step 2: Update executor cache signature**

Include chain and CLI env values:

```ts
const chainConfig = process.env.TRANSLATION_PROVIDER_CHAIN ?? "";
const cliConfig = [
  process.env.CLAUDE_CODE_MODEL ?? "",
  process.env.CLAUDE_CODE_BARE ?? "",
  process.env.CLAUDE_CODE_MAX_BUDGET_USD ?? "",
  process.env.CODEX_CLI_MODEL ?? "",
  process.env.CODEX_CLI_ALLOW_BYPASS ?? "",
].join("|");
const sig = `chain:${chainConfig}|cli:${cliConfig}|${s.provider}|${s.apiKey ? hashKey(s.apiKey) : ""}|${s.model ?? ""}`;
```

- [ ] **Step 3: Write provider metadata**

On success:

```ts
model: result.model,
lastProvider: result.model.split(":")[0],
lastErrorCode: null,
```

On final failure:

```ts
const chainError = err instanceof ProviderChainError ? err : null;
// Use finalCode directly from ProviderChainError — do NOT re-run classifyLLMError on a
// ProviderChainError, because its message does not match existing classifier patterns and
// would return "unknown", breaking the [quota_exhausted] prefix the UI quota banner relies on.
const classified = chainError
  ? { code: chainError.finalCode, friendly: "All providers failed", raw: chainError.message.slice(0, 500) }
  : classifyLLMError(err);
await db.update(translations).set({
  status: "failed",
  errorMessage: formatErrorMessage(classified),
  lastProvider: chainError?.finalProvider ?? null,
  lastErrorCode: classified.code,
  updatedAt: new Date().toISOString(),
}).where(/* ... */);
```

- [ ] **Step 4: Verify**

Run:

```powershell
npx vitest run src/lib/llm/__tests__/provider.test.ts src/lib/llm/__tests__/provider-chain.test.ts
```

Expected: existing providers still work and chain mode works.

## Task 8: Add Failed-Row Requeue

**Files:**
- Create: `worker/failed-requeue.ts`
- Create: `worker/__tests__/failed-requeue.test.ts`
- Modify: `worker/index.ts`

- [ ] **Step 1: Write requeue tests**

Cover:

- Requeues `failed` rows below retry limit with retryable codes.
- Requeues historical failed rows where `lastErrorCode` is `null`.
- Does not requeue rows at or above retry limit.
- Does not requeue `auth_error` or `model_not_found`.
- Returns the count of requeued rows.

- [ ] **Step 2: Implement requeue helper**

Use Drizzle ORM:

```ts
import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { translations } from "@/lib/db/schema";
import { getDb } from "@/lib/db";

const PERMANENT_CODES = ["auth_error", "model_not_found"];

export interface RequeueFailedOptions {
  retryLimit: number;
  batchSize: number;
}

export async function requeueEligibleFailedTranslations(
  options: RequeueFailedOptions,
): Promise<number> {
  const db = getDb();
  const now = new Date().toISOString();

  const rows = await db
    .select({ id: translations.id })
    .from(translations)
    .where(
      and(
        eq(translations.status, "failed"),
        lt(translations.retryCount, options.retryLimit),
        or(
          isNull(translations.lastErrorCode),
          notInArray(translations.lastErrorCode, PERMANENT_CODES),
        ),
      ),
    )
    .limit(options.batchSize);

  if (rows.length === 0) return 0;

  const ids = rows.map((r) => r.id);
  await db
    .update(translations)
    .set({
      status: "pending",
      errorMessage: null,
      retryCount: sql`${translations.retryCount} + 1`,
      updatedAt: now,
    })
    .where(inArray(translations.id, ids));

  return ids.length;
}
```

- [ ] **Step 3: Wire into worker idle path**

In `worker/index.ts`, after idle final progress logging:

```ts
if (process.env.WORKER_REQUEUE_FAILED_WHEN_IDLE === "true") {
  const retryLimit = Number(process.env.WORKER_FAILED_RETRY_LIMIT ?? 2);
  const batchSize = Number(process.env.WORKER_FAILED_RETRY_BATCH_SIZE ?? 500);
  const requeueResult = await runRecoverableStep("requeueEligibleFailed", () =>
    requeueEligibleFailedTranslations({ retryLimit, batchSize }),
  );
  if (requeueResult.ok && requeueResult.value > 0) {
    console.log(`[worker] Requeued ${requeueResult.value} failed rows for retry`);
    finalProgressLogged = false;
    continue;
  }
}
```

- [ ] **Step 4: Verify**

Run:

```powershell
npx vitest run worker/__tests__/failed-requeue.test.ts worker/__tests__/progress.test.ts
```

Expected: requeue behavior passes and existing progress tests still pass.

## Task 9: End-to-End Verification

**Files:**
- Modify only if tests expose an integration issue.

- [ ] **Step 1: Run full test suite**

```powershell
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run worker with local-only chain**

Set:

```env
TRANSLATION_PROVIDER_CHAIN=ollama
```

Run:

```powershell
npm run worker
```

Expected: existing worker behavior is unchanged.

- [ ] **Step 3: Run worker with Claude fallback chain**

Set:

```env
TRANSLATION_PROVIDER_CHAIN=claude-code,ollama
CLAUDE_CODE_ENABLED=true
CLAUDE_CODE_BARE=false
```

Run:

```powershell
npx pm2 restart prism-worker --update-env
npx pm2 logs prism-worker --lines 50 --nostream
```

Expected: worker starts and fallback does not crash the worker.

- [ ] **Step 4: Test circuit breaker with unit fake provider**

Do not use a missing command for permanent-disable testing. A missing executable is `ENOENT` and should classify as `network` or `unknown`, which is transient.

In tests, use a fake provider that throws an error message classified as `quota_exhausted` or `auth_error` and confirm:

- provider is added to `disabledProviders`
- current row falls through to next provider
- reconstructed chain skips disabled provider
- PM2 restart clears disabled state in real runtime

- [ ] **Step 5: Optional Codex smoke test**

Only after accepting the bypass risk:

```env
TRANSLATION_PROVIDER_CHAIN=codex,ollama
CODEX_CLI_ENABLED=true
CODEX_CLI_ALLOW_BYPASS=true
```

Run:

```powershell
npx pm2 restart prism-worker --update-env
npx pm2 logs prism-worker --lines 50 --nostream
```

Expected: Codex either produces a validated translation or falls back to Ollama without row loss.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/llm worker drizzle src/lib/db/schema.ts docs/superpowers/specs/2026-06-01-cli-probe-notes.md
git commit -m "feat(worker): add CLI translation provider chain with fallback and failed-row retry"
```

## Rollout Plan

1. Deploy migration and code.
2. Start with `TRANSLATION_PROVIDER_CHAIN=ollama` to confirm no regression.
3. Enable `TRANSLATION_PROVIDER_CHAIN=claude-code,ollama` for a small batch.
4. Add Codex only after Claude path is stable and the operator accepts bypass risk.
5. Enable `WORKER_REQUEUE_FAILED_WHEN_IDLE=true` only after retry metadata is confirmed.

## Backout Plan

Set:

```env
TRANSLATION_PROVIDER_CHAIN=ollama
WORKER_REQUEUE_FAILED_WHEN_IDLE=false
CODEX_CLI_ENABLED=false
```

Then restart:

```powershell
npx pm2 restart prism-worker --update-env
```

The new retry metadata columns remain unused; they do not affect existing translation reads.
