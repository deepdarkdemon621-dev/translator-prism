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

## Single-worker deployment

Run exactly one worker per Turso database. On startup the worker flips every
row in `processing` back to `pending` to recover from its own crashes — if a
second worker were running against the same DB, this reset would steal rows
that are mid-translation on the sibling, causing double LLM spend.

If you need to fan out across machines later, add a `locked_until` lease
column to `translations` and reset only rows whose lease has expired. Until
then: one worker, one DB.

## Switching LLM backends

Edit `.env.worker`:
- Ollama → llama.cpp server: change `LLM_PROVIDER_BASE_URL`
- Local → OpenAI: change `LLM_PROVIDER=openai` and set `LLM_API_KEY`

Restart the worker (`pm2 restart prism-worker`) to pick up changes.
