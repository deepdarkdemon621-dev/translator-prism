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

Observed non-`--bare` probe behavior:

- Command with `--output-format json`, `--tools ""`, `--no-session-persistence`, and `--max-budget-usd 0.01` exited with code `1`.
- Stdout was a JSON result envelope with `subtype: "error_max_budget_usd"` and `errors: ["Reached maximum budget ($0.01)"]`.
- Reported cost was approximately `$0.0126426`, so even a tiny non-`--bare` probe can exceed a `0.01` per-call cap.
- Debug logging showed hooks/MCP/LSP/plugin startup, so the default should remain configurable and budget-capped.

Observed `--bare` probe behavior:

- Command with `--bare`, `--json-schema`, and `--max-budget-usd 0.005` did not return within 49 seconds and was stopped.
- Because `--bare` changes auth to API-key/apiKeyHelper only, keep `CLAUDE_CODE_BARE=false` as the default.

Fixture status:

- `src/lib/llm/__fixtures__/claude-cli-output.json` is a schema-shaped parser fixture: `{"text":"hello"}`.
- A successful Claude translation stdout fixture was not captured in this pass to avoid further paid probes.

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
