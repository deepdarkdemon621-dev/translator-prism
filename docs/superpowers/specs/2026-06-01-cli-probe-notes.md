# CLI Probe Notes

Date: 2026-06-01
Workspace: `C:\Programming\translator\.worktrees\cli-translation-provider-chain`

## Claude Code

Confirmed CLI support from `claude --help`:

- `--bare`
- `--json-schema`
- `--max-budget-usd`
- `--no-session-persistence`
- `--output-format text|json|stream-json`

## Systematic flag probes — 2026-06-01 (second pass)

All probes used `echo '...' | claude -p --model sonnet ... 2>&1` via bash.

| Probe | Command flags | Result | Time |
|-------|--------------|--------|------|
| A | `--output-format json --no-session-persistence` | ✓ envelope `{"type":"result",...,"result":"{\"text\":\"OK\"}"}` | ~12s |
| B | `--output-format text --no-session-persistence` | ✓ plain `OK` | ~9s |
| C | `--output-format json --tools "" --no-session-persistence` | ✓ same envelope as A | ~11s |
| D | `--json-schema <schema> --no-session-persistence` | empty stdout (no output at all) | ~12s |
| E | `--output-format json --bare --no-session-persistence` | `is_error:true`, `result:"Not logged in · Please run /login"` | ~2s |

**Key findings:**

- `--tools ""` is safe — does not hang or cause timeout.
- `--json-schema` produces **empty stdout** — was the root cause of worker timeouts when this flag was in use.
- `--bare` breaks subscription auth (API-key-only mode); keep `CLAUDE_CODE_BARE=false`.
- Stable production command: `claude -p --output-format json --model sonnet --tools "" --no-session-persistence`

Observed non-`--bare` probe behavior (first pass):

- Command with `--output-format json`, `--tools ""`, `--no-session-persistence`, and `--max-budget-usd 0.01` exited with code `1`.
- Stdout was a JSON result envelope with `subtype: "error_max_budget_usd"` and `errors: ["Reached maximum budget ($0.01)"]`.
- Reported cost was approximately `$0.0126426`, so even a tiny non-`--bare` probe can exceed a `0.01` per-call cap.
- Debug logging showed hooks/MCP/LSP/plugin startup, so the default should remain configurable and budget-capped.

Fixture status:

- `src/lib/llm/__fixtures__/claude-cli-output.json` updated to real `--output-format json` envelope format.
- Implementation already switched from `--json-schema` to `--output-format json` in cli-providers.ts.

## Codex CLI

Confirmed CLI support from `codex exec --help`:

- `-m, --model`
- `-s, --sandbox`
- `--ephemeral`
- `--json`
- `--output-last-message`
- `--dangerously-bypass-approvals-and-sandbox`

Windows command resolution:

- PowerShell resolves `codex` to `C:\nvm4w\nodejs\codex.ps1`.
- `C:\nvm4w\nodejs\codex.cmd` also exists and is the correct `shell: false` target.
- The runner must prefer `.cmd` over `.ps1`.

Observed Codex probe behavior:

- `codex exec -m o3 -s read-only --ephemeral --json -` returned JSONL error events:
  `The 'o3' model is not supported when using Codex with a ChatGPT account.`
- `codex exec -s read-only --ephemeral --json -` succeeded without bypass and emitted JSONL.
- Final text appeared at:
  `{"type":"item.completed","item":{"type":"agent_message","text":"{\"text\":\"hello\"}"}}`

Fixture status:

- `src/lib/llm/__fixtures__/codex-cli-output.jsonl` is captured from the successful default-model probe.
