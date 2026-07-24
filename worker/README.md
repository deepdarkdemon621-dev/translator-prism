# Prism Worker

The worker polls Turso for pending translation rows and sends chapter batches
to one explicitly approved Claude Code or Codex CLI provider. It is separate
from the Vercel-hosted Next.js app — the app just writes `pending` rows to the
DB.

## Files

```
worker/
├── index.ts              main loop — don't edit unless changing behaviour
├── ecosystem.config.cjs  PM2 config (script path, log files, autorestart)
└── README.md             this file

.env.worker               Turso creds + LLM config (gitignored, sensitive)
logs/
├── worker-out.log        stdout from the worker
└── worker-err.log        stderr + warnings
```

## First-time setup

1. Install Node.js 20+ and this project's dependencies:
   ```
   npm install
   ```
2. Copy `.env.worker.example` to `.env.worker` and fill in:
   - `TURSO_DATABASE_URL` — the Turso URL (same value as Vercel's env var)
   - `TURSO_AUTH_TOKEN` — the Turso auth token
   - `TRANSLATION_PROVIDER_CHAIN` — exactly `claude-code` or `codex`
   - the matching enable/model variables for that CLI

3. Confirm the selected CLI is installed and authenticated with
   `claude --version` or `codex --version`. Do not add a local LLM fallback.

## Running in the foreground (for testing)

```
npm run worker
```

Leaves the worker attached to the terminal. Ctrl+C stops it cleanly.

## Running in the background (production)

Uses PM2, which auto-restarts on crash. All commands below assume you're in
the project root (`C:\Programming\translator` or equivalent).

### Start

```
npm run worker:pm2
```

First time you use PM2 you may also want to save the process list and enable
boot-start:

```
npx pm2 save
npx pm2 startup        # Linux/macOS only
npx pm2-installer install   # Windows — installs PM2 as a Windows service
```

On Windows, if you skip `pm2-installer`, the PM2 daemon is tied to the user
session and may die when you log out. Running as a service is the robust
option.

### Daily operations

```
# Status (should show 'online')
npx pm2 list

# Live logs — Ctrl+C to detach (doesn't stop the worker)
npx pm2 logs prism-worker

# Last 50 lines, no tail
npx pm2 logs prism-worker --lines 50 --nostream

# Pause (config retained, resumable)
npx pm2 stop prism-worker

# Resume
npx pm2 start prism-worker

# Restart (picks up code changes)
npx pm2 restart prism-worker

# Restart AND reload .env.worker (needed after editing env vars)
npx pm2 restart prism-worker --update-env

# Delete from PM2 entirely
npx pm2 delete prism-worker
```

### Closing the terminal window

The PM2 daemon is a separate process, so closing the window that ran
`npm run worker:pm2` is safe *as long as* you've run `npx pm2 save` and
either installed PM2 as a service (Windows) or enabled systemd integration
(Linux). Without those, behaviour on Windows is flaky — the daemon sometimes
exits with the session.

Play it safe: install `pm2-installer` once (Windows) or run `pm2 startup`
(Linux/macOS) so PM2 runs as a real service.

### Translation progress

The worker logs local progress every 5 minutes by default:

```
[worker] progress source=memory claimed=120 done=118 failed=1 skipped=0 inFlight=1
```

This line is based on the current worker process' in-memory counters, so it
does not read Turso. When the worker drains the queue, it performs one final
Turso aggregate and logs the authoritative totals:

```
[worker] final progress source=turso done=54874 pending=0 processing=0 failed=0
```

To change the local progress interval, set:

```
WORKER_PROGRESS_LOG_INTERVAL_MS=300000
```

To check the current Turso totals manually, run:

```
npx tsx scripts/check-progress.mjs
```

Output looks like:

```
translations: [
  { status: 'done',       c: 342  },
  { status: 'pending',    c: 7501 },
  { status: 'processing', c: 2    }
]
```

Or query Turso Studio directly at https://app.turso.tech → your DB → SQL shell:

```sql
SELECT status, COUNT(*) FROM translations GROUP BY status;
```

## Single-worker deployment

Local restarts now replace the previous local worker automatically. If the
lock file points at an unrelated process because the PID was reused, the worker
reclaims the lock without killing that process.

Run exactly one worker per Turso database (operational rule). Claims are
lease-based: each claimed row records `claimed_by` (this worker's
`hostname:pid:uuid`) and `lease_expires_at` (`WORKER_LEASE_MS`, renewed every
`WORKER_LEASE_HEARTBEAT_MS` while in flight). There is no full-table
`processing → pending` reset anymore — after a crash, the crashed worker's
rows become claimable again automatically once their leases expire, and all
result writes are guarded by `claimed_by` and the claim-time source text.
Repeated enqueue also leaves active `processing` rows untouched.

Each claim takes one chapter + one target language, ordered by paragraph
sequence, bounded by `WORKER_BATCH_SIZE` and optionally
`WORKER_BATCH_MAX_CHARS`. Results go through per-item validation; valid items
commit in one Turso write batch (with attempt history in
`translation_attempts` and a run record in `translation_runs`) even when
sibling items are rejected.

## Selecting the CLI provider

Use exactly one provider per approved run. For Codex:

```env
TRANSLATION_PROVIDER_CHAIN=codex
CODEX_CLI_ENABLED=true
CODEX_CLI_MODEL=gpt-5.6-sol
CODEX_CLI_REASONING_EFFORT=high
CODEX_CLI_ALLOW_BYPASS=false
WORKER_CLAUDE_WINDOW_ONLY=false
```

For Claude Code, use the example in the next section. Do not append `ollama`
or another fallback provider; quota, auth, and model errors must remain
visible.

Then restart with env reload:

```
npx pm2 restart prism-worker --update-env
```

Plain `restart` without `--update-env` keeps the old env values.

## Claude CLI-provider mode

Use this when you want Claude Code to translate the existing
`pending` queue while preserving the worker's normal DB claim/write/retry
logic. Do not ask an interactive Claude Code/Codex chat session to write
translations directly into the database; let `prism-worker` remain the queue
owner.

This mode intentionally does not fall back to the local LLM. When the Claude
window closes, the worker stays online but stops claiming new translation rows.

Example `.env.worker`:

```env
TRANSLATION_PROVIDER_CHAIN=claude-code

CLAUDE_CODE_ENABLED=true
CLAUDE_CODE_COMMAND=claude
CLAUDE_CODE_MODEL=sonnet
CLAUDE_CODE_TIMEOUT_MS=120000
CLAUDE_CODE_MAX_BUDGET_USD=
CLAUDE_CODE_BARE=false
CLAUDE_CODE_CONCURRENCY=1
CLAUDE_CODE_ALLOWED_WEEKLY_WINDOW=FRI 00:00-SAT 10:00
CLAUDE_CODE_WINDOW_TZ=Asia/Tokyo
CLAUDE_CODE_EXCLUSIVE_WITHIN_WINDOW=true
CLAUDE_CODE_EXCLUSIVE_RETRY_DELAY_MS=60000
WORKER_CLAUDE_WINDOW_ONLY=true

WORKER_REQUEUE_FAILED_WHEN_IDLE=true
WORKER_FAILED_RETRY_LIMIT=2
WORKER_FAILED_RETRY_BATCH_SIZE=500
```

Then reload PM2 env:

```powershell
npx pm2 restart prism-worker --update-env
```

Expected behavior:

- The worker tries `claude-code` first.
- Outside `CLAUDE_CODE_ALLOWED_WEEKLY_WINDOW`, the worker does not claim new
  rows, so pending translations remain pending for the next run/window.
- If `CLAUDE_CODE_EXCLUSIVE_WITHIN_WINDOW=true`, Claude Code quota/rate-limit
  failures are retried during the allowed window instead of falling through.
- Once the Claude Code window closes, in-flight translations finish and the
  worker pauses before claiming more rows.
- Outside exclusive-window mode, if Claude Code hits quota/budget/auth/model
  failure, the provider is disabled for this worker process and the same row
  fails because no fallback provider is configured.
- Re-enabling a disabled CLI provider requires a worker restart:
  `npx pm2 restart prism-worker --update-env`.

`CLAUDE_CODE_BARE=false` is the default because `--bare` uses API-key style
auth and may not work with a normal Claude Code subscription login. Before
turning on Claude Code for a large batch, run a small real probe and confirm
that `claude -p --output-format json --tools "" --no-session-persistence`
returns a JSON envelope whose `result` field contains only translated text on
your machine.

In non-bare mode, the worker does not pass `ANTHROPIC_API_KEY` to the Claude
Code subprocess. This lets Claude Code use your local subscription login even
when `.env.local` contains an API key for the SDK-based provider.

For Claude subscription quota that resets every Saturday at 10:00 Japan time,
set the window to end at the reset boundary, for example
`FRI 00:00-SAT 10:00`. With exclusive-window mode enabled, the worker keeps
trying Claude during that window and stops claiming new work after 10:00 JST.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `pm2 list` shows `online` but `0b mem` / `0 cpu` | Stale daemon state | `npx pm2 restart prism-worker` |
| CLI command is not found | Claude Code or Codex is not installed/in `PATH` | Verify `claude --version` or `codex --version`, then restart |
| `failed` rows piling up in `translations` | Model or network issue | `npx pm2 logs prism-worker` for the last stack trace |
| Rows stuck in `processing` after a crash | Lease not yet expired | Wait `WORKER_LEASE_MS` (default 10 min); the next claim recovers them |
| Translations happen but don't appear in the reader | Browser cached the old chapter | Refresh the chapter page |
