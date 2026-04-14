# Handover — Trilingual EPUB Reader

This document brings a fresh agent up to speed on the project so development can continue without re-deriving context. Read `docs/superpowers/specs/2026-04-10-trilingual-epub-reader-design.md` for the full design and `docs/superpowers/plans/2026-04-10-trilingual-epub-reader.md` for the original implementation plan.

## What this is

A self-hosted Next.js 16 web app for reading Japanese/Chinese/English EPUB novels with synchronized machine translation. User uploads an EPUB, the backend parses it into chapters and paragraphs, an LLM translates paragraphs into the two other languages, and the reader shows up to three columns side-by-side with click-to-highlight synchronization.

## Current status

All 14 original plan tasks are implemented. Since then, several follow-up work streams have landed on top of the original commit (`1ae0bd2`):

- **Vocabulary edit dialog** — `VocabularyEditDialog` (Base UI) hooked into `/vocabulary` page with inline edit + delete.
- **Translation resume / per-paragraph retry UX** — API surfaces per-paragraph `errorMessage`, failed paragraphs render an error card with a retry button, chapter poll loop exits on `error`, auto-retry fires on chapter `pending | error`, and the retry route flips the chapter back to `translating` so polling restarts cleanly.
- **UI beautification pass** — warm ink/paper oklch palette (light + dark), Fraunces variable heading font via `next/font/google`, body radial-gradient background (`background-attachment: fixed`), custom scrollbars, a `stagger-fade-in` @utility keyframe, and reworked `BookCard`, `UploadZone`, `TopBar` (segmented view-mode pill + icon buttons), `BottomBar` (top progress bar + `backdrop-blur-xl`), `ChapterSidebar` (animated width + indicator bar), `ColumnView` (`max-w-[42rem]` centered + uppercase tracking header), `ParagraphBlock` (ring highlight + pulse). Dictionary / vocabulary / settings pages share a consistent header with a prominent circular back button (`h-10 w-10` ring, 18 px stroke-2.25 icon, `hover:-translate-x-0.5`).

### What's verified
- `npm run build` — clean as of the current state, 21 routes
- `npm test` — 17/17 Vitest tests passing (db schema, EPUB parser, provider factory, translation queue)
- API smoke tests via HTTP (upload → books list → settings round-trip) done during task 14
- Dev server boots; home, reader, settings, dictionary, vocabulary all render

### What's NOT verified (pending manual work)
- **Real translation end-to-end** — no one has plugged in a real API key and watched a chapter translate through the queue. The provider abstractions are unit-tested, but nothing has exercised the full `upload → parse → translate → render` path with a live LLM.
- **Docker build + runtime** — `Dockerfile` and `docker-compose.yml` are written but never executed. The user asked us to skip `docker compose build/up` to avoid disturbing other running containers. The alpine build toolchain fix (`python3 make g++` for `better-sqlite3`) is in place but unverified.
- **EPUB export** — `/api/export/[bookId]` route exists and has an HTML-escape fix applied, but no one has downloaded the result and opened it in an EPUB reader.

## Tech stack — read this before editing anything

**This is NOT the Next.js you know.** Pinned versions with breaking changes from the training data:

| Package | Version | Notes |
|---|---|---|
| `next` | 16.2.3 | App Router + Turbopack. Read `node_modules/next/dist/docs/` before writing route handlers, layouts, or config. See `AGENTS.md`. |
| `react` / `react-dom` | 19.2.4 | |
| `@base-ui/react` | ^1.3.0 | **NOT Radix.** shadcn components in `src/components/ui/` wrap `@base-ui/react/*` primitives. APIs differ significantly (see gotchas below). |
| `drizzle-orm` + `better-sqlite3` | 0.45.2 / 12.8.0 | Synchronous SQLite. |
| `openai` | 6.34.0 | Used for both OpenAI and OpenRouter (OpenRouter is OpenAI-compatible, just a different `baseURL`). |
| `@anthropic-ai/sdk` | 0.87.0 | Claude provider. |
| `tailwindcss` | v4 | PostCSS-based, not the v3 config you may remember. |
| `vitest` | 4.1.4 | Test runner. |

### Base UI gotchas (bitten us multiple times)
- `Sheet` / `Dialog` `onOpenChange` signature is `(open: boolean, eventDetails) => void`, NOT Radix's `(open: boolean) => void`. Pattern: `onOpenChange={(open) => { if (!open) onClose(); }}`.
- `Slider` value is `number | readonly number[]`. Always unwrap: `const val = Array.isArray(v) ? v[0] : v; if (val !== undefined) ...`.
- `Slider` `thumbAlignment` must be `"center"`. Any other value (including the default `"edge"`) makes Base UI's `SliderThumb` emit a prehydration `<script>` tag for SSR positioning, which React 19 warns about: *"Encountered a script tag while rendering React component."* See `src/components/ui/slider.tsx`.
- `Select` `onValueChange` may emit `null`. Guard: `if (v !== null) ...`.
- `SelectTrigger` defaults to `w-fit`, not `w-full` — add `className="w-full"` explicitly when placing in a form.

### Next.js 16 gotchas
- `src/instrumentation.ts` runs once at server startup. We use it to run Drizzle migrations via dynamic import, guarded by `process.env.NEXT_RUNTIME === "nodejs"`. This is **required** — without it, a fresh DB has no tables and every API call 500s.
- `next.config.ts` must set `output: "standalone"` and `serverExternalPackages: ["better-sqlite3"]` for Docker to work.
- **`next/font/google` variable fonts**: when you specify `axes` (e.g. `axes: ["SOFT", "opsz"]` on Fraunces), you MUST NOT also pass a `weight` array. The loader errors with *"Axes can only be defined for variable fonts when the weight property is nonexistent or set to `variable`."* See `src/app/layout.tsx` Fraunces config.

## Running locally

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # 17 tests
npm run build        # verify production build
```

Settings live in `data/settings.json` (gitignored). The `data/` directory is auto-created on first run; SQLite DB lives at `data/translator.db`.

### First-time setup for translation
1. Start dev server.
2. Visit `/settings`.
3. Choose provider: `Claude`, `OpenAI`, or `OpenRouter (多模型聚合)`.
4. Paste API key, pick model, set concurrency (2 is a safe default).
5. Save. **This triggers `resetTranslationQueue()`** — the singleton is rebuilt with the new provider on the next request. You should NOT need to restart the dev server after changing provider/key.
6. Upload an EPUB on the home page. Translation starts automatically when you open a chapter.

### Environment variables (optional)
- `ANTHROPIC_API_KEY` — if set AND provider is `claude`, this overrides the settings.json key (backwards-compat for the original deployment).
- No env var for OpenAI/OpenRouter keys — they only come from `data/settings.json`.

## Docker

```bash
docker compose up --build
# → http://localhost:3100 (intentionally NOT 3000 — user has another project there)
```

Volume `app-data` persists `/app/data` across restarts. `.env.local` is optional (`required: false`). The Dockerfile uses `node:20-alpine` and installs `python3 make g++` in the deps stage before `npm ci` because `better-sqlite3` compiles native bindings.

## Architecture map

```
src/
├── app/
│   ├── page.tsx                    # Home / library list with upload
│   ├── settings/page.tsx           # LLM provider config
│   ├── read/[bookId]/page.tsx      # Reader shell (server component → ReaderLayout)
│   └── api/
│       ├── books/                  # list, upload, get, delete
│       ├── chapters/[id]/          # get content, trigger translate, status
│       ├── paragraphs/[id]/retry/  # manual retry for failed paragraphs
│       ├── progress/[bookId]/      # reading progress PUT
│       ├── settings/               # GET/PUT settings.json — PUT resets queue singleton
│       └── export/[bookId]/        # build + download translated EPUB
├── components/
│   ├── reader/
│   │   ├── ReaderLayout.tsx        # state machine: chapter loading, polling, view mode
│   │   ├── ColumnView.tsx          # one language column, paragraph spacing prop
│   │   ├── ParagraphBlock.tsx      # click-to-highlight paragraph
│   │   ├── ChapterSidebar.tsx, TopBar.tsx, BottomBar.tsx, SettingsDrawer.tsx
│   └── ui/                         # shadcn wrappers over Base UI
├── lib/
│   ├── db/                         # Drizzle schema, migration runner, init
│   ├── epub/parser.ts              # JSZip + cheerio → chapters + paragraphs
│   ├── llm/
│   │   ├── types.ts                # LLMProvider interface
│   │   ├── claude.ts               # ClaudeProvider
│   │   ├── openai.ts               # OpenAIProvider — serves BOTH openai AND openrouter via baseURL
│   │   └── factory.ts              # createProvider(name, apiKey)
│   ├── queue/translation-queue.ts  # singleton queue, resetTranslationQueue() for settings reload
│   ├── export/exporter.ts          # rebuild EPUB with translations
│   └── chapter-status.ts           # derived status helper
└── instrumentation.ts              # run DB migrations at startup
```

### Data model (SQLite via Drizzle)
`books → chapters → paragraphs → translations` (with `reading_progress` sibling table). See `src/lib/db/schema.ts` for the authoritative definition. Source text stays in `paragraphs.source_text`, each target language gets its own `translations` row keyed by `(paragraph_id, lang)`.

### Translation flow
1. User opens a chapter → `GET /api/chapters/[id]` returns paragraphs + any existing translations.
2. If chapter status is `pending`, client fires `POST /api/chapters/[id]/translate`.
3. Route handler enqueues one job per `(paragraph, target_lang)` into the singleton `TranslationQueue`.
4. Queue pulls jobs at `concurrency` parallelism, calls `provider.translate(...)`, writes result back to DB.
5. Client polls `GET /api/chapters/[id]` every 3s until status is `done`.

### Provider abstraction
- `LLMProvider` interface: `translate(text, fromLang, toLang, model?) → Promise<TranslationResult>`.
- `ClaudeProvider` uses `@anthropic-ai/sdk`.
- `OpenAIProvider` uses `openai` SDK and takes `{ baseURL?, name, defaultModel }`. The factory instantiates it twice: once as `openai` with default baseURL, once as `openrouter` with `baseURL: "https://openrouter.ai/api/v1"`.
- To add a provider: implement `LLMProvider`, add a case to `createProvider()` in `src/lib/llm/factory.ts`, add the models list to `MODELS` and a label to `PROVIDER_LABELS` in `src/app/settings/page.tsx`.

## Latent bug that was fixed (worth knowing)

The original `getTranslationQueue()` hardcoded `createProvider("claude", process.env.ANTHROPIC_API_KEY)` and completely ignored `settings.json`. Changing provider in the UI had zero effect. This was fixed during the OpenAI/OpenRouter addition: the queue now reads settings on first construction, and `PUT /api/settings` calls `resetTranslationQueue()` so subsequent requests rebuild with the new provider. **If you refactor the queue, preserve this reset behavior** or settings changes will silently no-op again.

## Known open items / good first pickups

1. **Exercise the translation pipeline end-to-end with a real key** — this is still the highest-priority gap. The retry-on-error path has now been wired up in the UI, but no one has actually driven a token-exhaustion or rate-limit scenario through it with a live provider.
2. **Build and run the Docker image** — verify alpine native compile works, verify the volume persists data, verify port 3100 binding.
3. **Manual UI pass on the reader** — single/dual/triple view switching, paragraph highlight sync across columns, settings drawer changes reflect live without reload, scroll position restore.
4. **EPUB export round-trip** — download an exported book, open it in a real EPUB reader, confirm translations are embedded correctly and the HTML escaping holds up on tricky input.
5. **Reader keyboard shortcuts** — not implemented. Would be a nice UX addition (j/k for paragraphs, h/l for chapters).

## Git state

- Base commit `1ae0bd2` on `master` contains the original 14-task implementation.
- **All subsequent work (vocabulary dialog, translation resume/retry UX, UI beautification) is currently uncommitted.** The user took over commit responsibility partway through the follow-up work — do NOT auto-commit; let the user stage and commit themselves.
- No remote configured. The previous agent did not have `gh` CLI; the user said they would push to GitHub themselves.
- `.claude/` and `.superpowers/` and `data/` and `.env.local` are gitignored.

## Development workflow used so far

This codebase was built using the Superpowers **subagent-driven development** flow: a plan at `docs/superpowers/plans/2026-04-10-trilingual-epub-reader.md` broken into 14 tasks, each dispatched to an implementer subagent followed by a spec-compliance review and a code-quality review. The plan file is authoritative for what was *supposed* to be built; if you see drift, the code is what's actually there. The plan and spec are preserved in-repo so a continuation agent can follow the same convention or switch to a different one.

## User preferences (from the build session)

- **Terse output, no ceremony.** Do not re-summarize what you just did; the diff speaks for itself.
- **Chinese or English both fine**, matches user's last message.
- **Do not disturb the user's other running Docker projects.** Port 3000 is taken by this project's dev server when running — reader uses 3100 in compose. When stopping services for this project, scope kills to processes whose command line contains `C:\Programming\translator` so other projects are untouched.
- **Do not commit on the user's behalf.** The user handles all git commits themselves. Stage-only is also discouraged — just leave the tree dirty and tell them what changed.
- **Do not auto-confirm destructive git operations** (reset --hard, force push, etc.) without asking.
- User has **no Claude API key** at the moment. OpenAI or OpenRouter is the practical default.
- **Aesthetic direction for this app:** warm paper/ink palette, serif display face (Fraunces) for headings, subtle radial-gradient backdrop, `backdrop-blur-xl` on bars, stagger-fade-in on lists, hover micro-interactions (lift / translate / ring). The user rejected wrapping pages in rounded-bordered "card" containers — said those made pages look like modals. Keep full-bleed page layouts with just the header + cards inside.
