# CLI Translation Provider Chain Design

## Goal

Allow the translation worker to use Claude Code and/or Codex CLI as optional local translation providers, while preserving the current worker behavior:

- Continue claiming `pending` translation rows from the remote database.
- Write successful translations back as `done`.
- Retry eligible `failed` rows after the current `pending` queue is drained.
- Fall back to the existing local LLM provider when Claude Code/Codex quota, token, auth, or budget is exhausted.

This design keeps the worker as the single queue owner. Claude Code and Codex are local provider adapters, not independent workers.

**Direction is one-way only:** CLI providers (Claude Code / Codex) -> local LLM (Ollama). When a CLI provider is disabled due to quota or auth errors, the worker continues on local LLM. There is no automatic switch back to CLI providers. Re-enabling a CLI provider requires a manual PM2 restart.

## Current State

Relevant files:

- `worker/index.ts` owns queue polling, `pending -> processing` claims, concurrency, shutdown, and progress logging.
- `src/lib/llm/executor.ts` loads each claimed row, calls a provider, writes `done` or `failed`, and runs chapter completion checks. It has a signature-based provider cache; the new chain config must be included in the cache signature.
- `src/lib/llm/types.ts` defines `LLMProvider.translate()`.
- `src/lib/llm/factory.ts` currently supports `claude`, `openai`, `openrouter`, and `ollama`.
- `src/lib/llm/errors.ts` classifies errors into `LLMErrorCode` and formats them for DB storage.
- `src/app/api/translations/retry-failed/route.ts` already resets visible `failed` rows to `pending`, but only through a user-triggered API call.

The correct extension point is the provider/executor layer. The worker loop should stay small and should not learn how to call CLI tools directly.

## Feasibility

Both local commands are available in this environment:

**Claude Code CLI** (`claude`):

- `-p/--print`: non-interactive mode.
- `--output-format text`: plain text stdout. Use `json` only if the implementation needs a larger output envelope with extra metadata.
- `--model <alias>`: accepts short aliases like `sonnet`, `opus`, `haiku` or full model IDs.
- `--tools ""`: disables all built-in tools.
- `--no-session-persistence`: prevents session files from being written to disk.
- `--bare`: minimal startup. It skips hooks, LSP, CLAUDE.md auto-discovery, plugin sync, OAuth/keychain reads, and several user/project setting sources. It can reduce startup time, but it also changes auth behavior: Claude Code will rely on `ANTHROPIC_API_KEY` or an apiKeyHelper instead of the normal logged-in subscription/session path. Make this configurable, not mandatory.
- `--json-schema <json>`: enforces structured JSON output matching the schema. Recommended for parse-safe output.
- `--max-budget-usd <amount>`: hard budget cap per call. Only works with `--print`.

**Codex CLI** (`codex exec`):

- `-m/--model <model>`: model selection.
- `-s/--sandbox <mode>`: sandbox policy: `read-only`, `workspace-write`, `danger-full-access`.
- `--ephemeral`: run without persisting session files.
- `--json`: print events to stdout as JSONL. Required for programmatic output capture.
- `--output-last-message <file>`: write just the last agent message to a file. This is a fallback if JSONL parsing proves fragile.
- `-` as the prompt argument: read prompt from stdin.
- `--dangerously-bypass-approvals-and-sandbox`: skip all confirmation prompts and execute without sandboxing. This is risky for untrusted text inputs because prompt injection could try to make the agent execute commands. Codex CLI provider must be disabled by default unless the operator explicitly enables this flag after accepting the risk.

They can be used for translation but are heavier and less deterministic than direct SDK calls. Each call starts an agent process, may include extra wrapper output, may rely on local auth state, and may fail for quota, budget, or session reasons. CLI output must be constrained and validated.

## Pre-Implementation Probe Requirement

Before implementing parsers, run a small probe for both CLIs and save representative outputs as test fixtures. Do not infer the JSONL event structure from memory.

Probe goals:

- Confirm whether Claude with `--json-schema` returns plain JSON text or a larger output envelope.
- Confirm whether Claude with `--bare` works with the local authentication method. If it fails because the user relies on Claude Code subscription/OAuth login, default `CLAUDE_CODE_BARE=false`.
- Confirm Codex `--json` JSONL event names and where the final assistant text appears.
- Confirm whether Codex can run with `-s read-only --ephemeral --json -` without bypass on this machine. If it prompts or blocks, require explicit `CODEX_CLI_ALLOW_BYPASS=true` before adding `--dangerously-bypass-approvals-and-sandbox`.

Recommended fixture paths:

- `src/lib/llm/__fixtures__/claude-cli-output.json`
- `src/lib/llm/__fixtures__/codex-cli-output.jsonl`

Parser tests must use these fixtures so future CLI changes are caught by tests.

## Recommended Architecture

Add a provider chain:

```text
runTranslation()
  -> ProviderChain.translate()
       -> ClaudeCodeCliProvider
       -> CodexCliProvider
       -> existing Ollama/OpenAI-compatible local provider
  -> executor writes done/failed exactly as today
```

The chain tries providers in order. If a provider fails with a fallback-eligible error, the chain immediately tries the next provider for the same translation row. The row should not become `failed` until every configured provider has failed.

Recommended default order after explicit opt-in:

```text
claude-code -> codex -> ollama
```

Safer low-cost mode, recommended for large books:

```text
ollama for normal pending rows
claude-code/codex only for failed-row retry
ollama fallback if CLI quota is exhausted
```

## Provider Responsibilities

Each CLI provider implements `LLMProvider`:

```ts
interface LLMProvider {
  name: string;
  translate(text: string, fromLang: string, toLang: string, model?: string): Promise<TranslationResult>;
}
```

The provider must:

- Build a strict translation-only prompt.
- Disable or minimize tool usage where the CLI supports it.
- Use a timeout so a hung CLI process cannot block worker concurrency forever.
- Capture stdout/stderr and exit code.
- Parse only the final translation payload.
- Reject empty translations, explanations, Markdown fences, or invalid output.
- Map quota/auth/rate/network/budget failures into `classifyLLMError()`.

### Claude Code CLI Command

Base command:

```text
claude -p --output-format text --model <model> --tools "" --no-session-persistence
```

With structured output enforcement:

```text
claude -p --output-format text --model <model> --tools "" --no-session-persistence \
  --json-schema '{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}'
```

With budget cap:

```text
claude -p --output-format text --model <model> --tools "" --no-session-persistence \
  --max-budget-usd 0.05
```

Add `--bare` only when `CLAUDE_CODE_BARE=true` and the probe confirms auth still works. This avoids breaking users whose Claude Code access comes from the normal local login/session path rather than `ANTHROPIC_API_KEY`.

### Codex CLI Command

Base command:

```text
codex exec -m <model> -s read-only --ephemeral --json -
```

The `-` at the end reads the prompt from stdin. `--json` outputs JSONL events to stdout. If probe testing shows the command blocks on approval, the provider may append `--dangerously-bypass-approvals-and-sandbox` only when `CODEX_CLI_ALLOW_BYPASS=true`. Codex provider should remain opt-in because bypass mode removes normal approval and sandbox guarantees.

### Expected Output Shape

Both providers must ultimately produce:

```json
{"text": "translated text only"}
```

Claude stdout: parse as JSON directly after stripping optional Markdown fences.

Codex stdout: parse JSONL events using the real fixture captured in Task 0. Extract the final assistant text, then parse that text as JSON.

The model label stored in the DB:

- `claude-code:sonnet`
- `codex:o3`
- `ollama:qwen2.5:7b`

Token usage is `0` for CLI providers unless the CLI exposes reliable usage data.

## Configuration

Add environment-driven configuration first. UI settings can be added later.

Proposed `.env.worker` keys:

```env
TRANSLATION_PROVIDER_CHAIN=claude-code,codex,ollama
TRANSLATION_FAILED_RETRY_PROVIDER_CHAIN=claude-code,codex,ollama

CLAUDE_CODE_ENABLED=true
CLAUDE_CODE_COMMAND=claude
CLAUDE_CODE_MODEL=sonnet
CLAUDE_CODE_TIMEOUT_MS=120000
CLAUDE_CODE_MAX_BUDGET_USD=
CLAUDE_CODE_BARE=false
CLAUDE_CODE_CONCURRENCY=1

CODEX_CLI_ENABLED=false
CODEX_CLI_COMMAND=codex
CODEX_CLI_MODEL=o3
CODEX_CLI_TIMEOUT_MS=120000
CODEX_CLI_ALLOW_BYPASS=false
CODEX_CLI_CONCURRENCY=1

LOCAL_LLM_PROVIDER=ollama
LOCAL_LLM_MODEL=qwen2.5:7b

WORKER_REQUEUE_FAILED_WHEN_IDLE=true
WORKER_FAILED_RETRY_LIMIT=2
WORKER_FAILED_RETRY_BATCH_SIZE=500
```

If `TRANSLATION_PROVIDER_CHAIN` is not set, keep current behavior from `loadLLMSettings()` to avoid breaking existing deployments.

## Windows Command Resolution

The runner should use `spawn()` with `shell: false` to avoid shell quoting and injection problems. On Windows, command resolution must account for shim files:

- `claude` resolves to `claude.exe` on this machine.
- `codex` may resolve to `codex.ps1`, `codex.cmd`, or an extensionless shim depending on `PATH` order.

Implement a small resolver for Windows:

1. If the configured command contains a path or extension, use it as provided.
2. If `process.platform === "win32"` and the command has no extension, prefer `<command>.cmd`, then `<command>.exe`, then `<command>`.
3. Keep `shell: false`.

This avoids accidentally trying to execute a PowerShell shim directly from Node.

## Executor Cache Compatibility

`executor.ts` maintains a signature-based provider cache:

```ts
const sig = `${s.provider}|${s.apiKey ? hashKey(s.apiKey) : ""}|${s.model ?? ""}`;
```

When the chain is active, include chain and CLI env config in the signature:

```ts
const chainConfig = process.env.TRANSLATION_PROVIDER_CHAIN ?? "";
const cliConfig = [
  process.env.CLAUDE_CODE_MODEL ?? "",
  process.env.CLAUDE_CODE_BARE ?? "",
  process.env.CODEX_CLI_MODEL ?? "",
  process.env.CODEX_CLI_ALLOW_BYPASS ?? "",
].join("|");
const sig = `chain:${chainConfig}|cli:${cliConfig}|${s.provider}|${s.apiKey ? hashKey(s.apiKey) : ""}|${s.model ?? ""}`;
```

This ensures that changing env vars with `pm2 restart --update-env` produces a fresh chain instance.

## Circuit Breaker and Fallback

Add an in-process circuit breaker per provider. The disabled state lives in a module-level `Set` inside `provider-chain.ts`, not on individual chain instances. This ensures disabled state persists even if the chain is recreated due to a settings change.

```ts
const disabledProviders = new Set<string>();
```

Disable permanently for the current process on:

- `quota_exhausted`
- `auth_error`
- `model_not_found`
- Claude budget exceeded

Fall through without permanent disable on:

- `rate_limit`
- `network`
- `invalid_output`
- `unknown`

Disabled providers are re-enabled only by restarting the worker process:

```powershell
npx pm2 restart prism-worker --update-env
```

Use a typed chain error instead of mutating generic `Error` objects:

```ts
interface ProviderAttemptFailure {
  providerName: string;
  code: LLMErrorCode;
  message: string;
}

class ProviderChainError extends Error {
  constructor(
    readonly attempts: ProviderAttemptFailure[],
    readonly finalProvider: string | null,
    readonly finalCode: LLMErrorCode,
  ) {
    super(`All providers failed: ${attempts.map((a) => `${a.providerName}:${a.code}`).join(", ")}`);
  }
}
```

The executor should use `finalCode` and `finalProvider` directly when the thrown error is a `ProviderChainError`, rather than re-running `classifyLLMError`. `classifyLLMError` does not recognise the ProviderChainError message and would return `unknown`, causing `errorMessage` to be stored as `[unknown] All providers failed: ...` even when the final code is `quota_exhausted`. This would silently break the quota banner in the UI, which relies on the `[quota_exhausted]` prefix.

```ts
const chainError = err instanceof ProviderChainError ? err : null;
const classified = chainError
  ? { code: chainError.finalCode, friendly: "All providers failed", raw: chainError.message.slice(0, 500) }
  : classifyLLMError(err);
// errorMessage gets [quota_exhausted] prefix when chain exhausts quota, not [unknown]
```

## Provider-Level Concurrency

Worker-level `WORKER_CONCURRENCY` controls how many rows are processed at once. CLI providers also need provider-level concurrency limits because starting multiple Claude/Codex processes in parallel can:

- consume budget unexpectedly,
- hit login/session file locks,
- make logs hard to inspect,
- amplify prompt-injection risk.

Default CLI provider concurrency should be `1`, independent of `WORKER_CONCURRENCY`. Ollama/local provider can keep using the worker concurrency.

## Failed-Row Retry Behavior

The current schema has no retry counter. Automatically requeuing all `failed` rows after `pending` is drained would risk an infinite loop.

Add retry metadata:

- `retry_count integer not null default 0`
- `last_provider text`
- `last_error_code text`

Recommended behavior:

1. Worker processes all `pending` rows as it does today.
2. When `pending=0` and `inFlight=0`, worker runs a failed-row requeue step.
3. It resets eligible failed rows:

```text
status='failed'
retry_count < WORKER_FAILED_RETRY_LIMIT
last_error_code is null or last_error_code in ('network', 'rate_limit', 'unknown', 'quota_exhausted', 'invalid_output')
```

4. It updates:

```text
status='pending'
error_message=null
retry_count=retry_count+1
updated_at=now
```

5. It does not requeue permanent errors:

```text
auth_error
model_not_found
retry_count >= limit
```

Historical failed rows created before this feature will have `last_error_code = null`. Treat those rows as `unknown` for retry eligibility, or backfill them to `unknown` during migration. The requeue query must explicitly include `last_error_code IS NULL`; SQL `NOT IN` does not match `NULL`.

## Data Flow

```text
Remote app / API
  -> creates translations.status='pending'

Local PM2 worker
  -> claimOne(): pending -> processing
  -> runTranslation()
       -> ProviderChain
            -> ClaudeCodeCliProvider | CodexCliProvider | OllamaProvider
       -> write done/failed + lastProvider + lastErrorCode
  -> when idle (pending=0, inFlight=0)
       -> requeue eligible failed rows
       -> continue polling
```

The tunnel/deployed app path is not changed by this design. The worker continues writing directly to the existing database path.

## Error Handling

Existing error codes:

- `quota_exhausted`: disable provider permanently for this process.
- `auth_error`: disable provider permanently for this process.
- `model_not_found`: disable provider permanently for this process.
- `rate_limit`: fall through; optional cooldown later.
- `network`: fall through.
- `unknown`: fall through.

Add a new code:

```ts
"invalid_output"
```

CLI-specific patterns:

| Pattern | Maps to |
|---|---|
| `budget exceeded`, `max budget`, `--max-budget-usd` | `quota_exhausted` |
| `login required`, `not authenticated`, `authentication required`, `please log in` | `auth_error` |
| `CLI process timed out` | `network` |
| `(err as {code?:string}).code === "invalid_output"` (instanceof CliOutputError) | `invalid_output` |
| CLI process exits with non-zero and no recognizable message | `unknown` |

Note: `invalid_output` must be detected via the error's `.code` property, not string matching. `CliOutputError` has `code = "invalid_output"` as an instance property but its `.message` is human-readable text that does not contain the literal string `"invalid_output"`. Checking `.message` for `"invalid_output"` will never match.

Only write final row failure after all providers fail. Preserve existing UI parsing by keeping the `[code]` prefix from `formatErrorMessage()`.

## Testing Strategy

Unit tests:

- Probe fixtures: parser tests use captured Claude/Codex fixture output.
- CLI output parser: accepts valid Claude JSON; parses final assistant message from Codex JSONL; rejects empty, non-JSON, or explanation-only output.
- CLI runner: resolves Windows shims, handles timeout, non-zero exit, stderr, and empty stdout.
- Provider chain: first provider success returns immediately; quota/auth/model errors disable provider; transient errors do not; module-level disabled set persists across chain instances.
- Error classifier: new CLI patterns map to correct codes.
- Failed-row requeue: respects retry limit; includes `last_error_code IS NULL`; excludes `auth_error` and `model_not_found`.

Integration-style tests:

- `runTranslation()` writes `done` when a later provider succeeds.
- `runTranslation()` writes `failed` only after all providers fail.
- Worker idle step requeues failed rows only after no pending rows remain.

Manual smoke tests:

- Start worker with `TRANSLATION_PROVIDER_CHAIN=ollama`.
- Start worker with `TRANSLATION_PROVIDER_CHAIN=claude-code,ollama`.
- Simulate quota/auth errors with a fake provider in tests, not by using a missing command.
- Confirm `npx pm2 restart prism-worker --update-env` picks up env changes and re-enables previously disabled providers.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| CLI startup cost is high | Use CLI providers only for failed retries or low concurrency. Keep Ollama as default for bulk processing. |
| Claude/Codex returns explanations instead of plain JSON | Use `--json-schema` for Claude; strict prompt for both; validate output before accepting. |
| `--bare` breaks Claude Code auth | Make `CLAUDE_CODE_BARE=false` the default. Enable it only after the probe confirms the local auth method supports it. |
| CLI auth/session expires | Classify as `auth_error`, disable provider until restart, fall back to local LLM. |
| Infinite failed retry loop | Add `retry_count` and a retry limit before automatic failed-row requeue. |
| Historical failed rows have `last_error_code = null` | Include `IS NULL` in retry eligibility or backfill null to `unknown`. |
| Token usage not reliable from CLI | Store `tokensUsed` as `0` for CLI providers; rely on provider-side budgets and circuit breaker for quota behavior. |
| Codex bypass flag is risky | Keep `CODEX_CLI_ENABLED=false` by default. Only append bypass when `CODEX_CLI_ALLOW_BYPASS=true`; document that EPUB text is untrusted input. |
| Windows `spawn` behavior | Use `shell: false` and resolve `.cmd`/`.exe` shims explicitly on Windows. |
| JSONL parsing complexity for Codex | Capture real fixture first; use `--output-last-message <tmpfile>` as fallback if JSONL proves fragile. |

## Out of Scope

- Running multiple workers against the same database.
- Replacing PM2.
- Changing the reader UI.
- Building a full provider-management UI before the env-based worker path works.
- Using Claude Code/Codex to directly edit database rows outside the worker.
- Automatic re-enablement of disabled providers without a restart.

## Recommendation

Implement in three phases:

1. Probe and fixture the real CLI output formats.
2. Add provider-chain fallback with CLI providers and local LLM fallback.
3. Add automatic failed-row requeue with retry counters.

This order keeps the current worker stable and validates the most uncertain part, CLI behavior, before touching queue retry behavior.

