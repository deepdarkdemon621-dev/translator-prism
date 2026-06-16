# Local EPUB Terminal Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `read:epub` / `--epub` support so the terminal reader opens a local EPUB file directly, resumes progress, and supports TOC chapter jumps without DB, env, upload, or translation.

**Architecture:** Keep `scripts/read.ts` as the entrypoint, but split the interactive terminal loop into reusable DB and EPUB paths. Add `src/lib/reader/terminal-epub.ts` for direct file parsing and progress key generation; keep progress in existing `data/terminal-progress.json`. EPUB mode uses original text only and never imports `getDb`.

**Tech Stack:** TypeScript, `tsx`, Vitest, existing `jszip`/`cheerio` EPUB parser, existing terminal reader helpers.

---

### Task 1: CLI Contract And Help

**Files:**
- Modify: `src/lib/reader/terminal-cli.ts`
- Test: `src/lib/reader/__tests__/terminal-cli.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing CLI tests**

Add tests that assert:

```ts
expect(parseTerminalReaderArgs(["--epub", "D:\\Books\\book.epub"])).toEqual({
  bookId: undefined,
  epubPath: "D:\\Books\\book.epub",
  envFile: undefined,
  langs: "auto",
  chapterIndex: undefined,
  listBooks: false,
  showHelp: false,
});

expect(parseTerminalReaderArgs(["D:\\Books\\book.epub"])).toEqual({
  bookId: undefined,
  epubPath: "D:\\Books\\book.epub",
  envFile: undefined,
  langs: "auto",
  chapterIndex: undefined,
  listBooks: false,
  showHelp: false,
});

expect(TERMINAL_READER_HELP).toContain("npm run read:epub --");
expect(TERMINAL_READER_HELP).toContain("--epub <path>");
expect(TERMINAL_READER_HELP).toContain("t");
expect(TERMINAL_READER_HELP).toContain("resume");
```

- [ ] **Step 2: Run failing tests**

Run:

```powershell
npx vitest run src/lib/reader/__tests__/terminal-cli.test.ts
```

Expected: fail because `epubPath` and help entries do not exist.

- [ ] **Step 3: Implement CLI parsing and script alias**

Add `epubPath?: string` to `TerminalReaderArgs`.

Parse:

```ts
const explicitEpubPath = getArgValue(argv, "--epub");
const positionalEpubPath =
  !explicitEpubPath && rawPositional[0]?.toLowerCase().endsWith(".epub")
    ? rawPositional[0]
    : undefined;
const epubPath = explicitEpubPath ?? positionalEpubPath;
```

Allow missing `bookId` when `epubPath`, `listBooks`, or `showHelp` is present.

Add package script:

```json
"read:epub": "tsx scripts/read.ts --epub"
```

Update help to document `read:epub`, `--epub`, `t` TOC, and automatic resume.

- [ ] **Step 4: Verify CLI tests pass**

Run:

```powershell
npx vitest run src/lib/reader/__tests__/terminal-cli.test.ts
```

Expected: all tests pass.

### Task 2: Local EPUB Loader

**Files:**
- Create: `src/lib/reader/terminal-epub.ts`
- Test: `src/lib/reader/__tests__/terminal-epub.test.ts`

- [ ] **Step 1: Write failing loader tests**

Test the existing fixture:

```ts
const fixture = path.join(
  process.cwd(),
  "src/lib/epub/__tests__/fixtures/test.epub",
);
const book = await loadTerminalEpub(fixture);
expect(book.title).toBeTruthy();
expect(book.progressKey).toMatch(/^epub:/);
expect(book.chapters.length).toBeGreaterThan(0);
expect(book.chapters[0].paragraphs.length).toBeGreaterThan(0);
expect(book.chapters[0].paragraphs[0]).toMatchObject({
  kind: "text",
  sourceLang: expect.any(String),
  translations: {},
});
```

Also assert the same relative path gives a stable key, and a missing file throws `EPUB file not found:`.

- [ ] **Step 2: Run failing loader tests**

Run:

```powershell
npx vitest run src/lib/reader/__tests__/terminal-epub.test.ts
```

Expected: fail because the module does not exist.

- [ ] **Step 3: Implement loader**

Create:

```ts
export type TerminalEpubBook = {
  progressKey: string;
  path: string;
  title: string;
  author: string;
  sourceLang: string;
  chapters: Array<{
    id: string;
    index: number;
    title: string;
    paragraphs: TerminalParagraph[];
  }>;
};
```

Implementation responsibilities:

- Resolve the EPUB path to an absolute path.
- Check `existsSync`; throw `EPUB file not found: <path>` if missing.
- Read bytes and call `parseEpub`.
- Hash the resolved absolute path with `crypto.createHash("sha256")`, first 16 hex chars, key `epub:<hash>`.
- Map each parsed paragraph:
  - text: `sourceText = paragraph.markup || paragraph.text`
  - image: `sourceText = paragraph.alt ? \`[image: ${paragraph.alt}]\` : "[image]"`
  - `translations: {}`
- Drop chapters with no paragraphs.
- Throw `EPUB has no readable content: <path>` if no readable chapters remain.

- [ ] **Step 4: Verify loader tests pass**

Run:

```powershell
npx vitest run src/lib/reader/__tests__/terminal-epub.test.ts
```

Expected: all tests pass.

### Task 3: EPUB Runtime Path And TOC Jump

**Files:**
- Modify: `scripts/read.ts`
- Test indirectly with CLI/loader tests and manual smoke

- [ ] **Step 1: Add EPUB runtime path**

In `main()`:

- Parse args as today.
- If `args.showHelp`, print help and exit.
- If `args.epubPath`, call a new `runEpubReader(args.epubPath)`.
- Only call `loadEnvForReader` and dynamic `getDb` import after the EPUB branch has returned.

This guarantees EPUB mode does not load env or DB.

- [ ] **Step 2: Extract shared render behavior only as needed**

Keep the DB reader working. For EPUB mode, implement the same page/chapter state machine using:

- `loadTerminalEpub`
- `loadTerminalProgress`
- `saveTerminalProgress`
- `paginateParagraphs`
- `renderParagraphBlock`

Use one source language mode only:

```ts
const langs = [terminalBook.sourceLang as ReaderLang];
```

If the source language is not one of the supported reader labels, print paragraphs directly as text after `stripHtmlForTerminal`.

- [ ] **Step 3: Add TOC prompt**

When the user presses `t`:

- Temporarily leave raw mode.
- Print numbered chapter list.
- Ask `Chapter number:`.
- Empty input returns to reading.
- Valid number sets `chapterIndex = number - 1` and `page = 0`.
- Restore raw mode and render.

The TOC only needs chapter-level jumps for this implementation.

- [ ] **Step 4: Manual smoke**

Run:

```powershell
npm run read:help
npm run read:epub -- src/lib/epub/__tests__/fixtures/test.epub
```

Expected:

- Help documents EPUB mode.
- Fixture opens without DB/env.
- `n`, `p`, `[`, `]`, `t`, and `q` work in a real TTY.
- Reopening the fixture resumes saved progress.

### Task 4: Verification And Handoff

**Files:**
- Modify: `AI_SESSION_ENTRY.md`
- Modify: `AI_HANDOFF_SUMMARY.md`
- Modify: `AI_TASK_BOARD.md`

- [ ] **Step 1: Run focused verification**

Run:

```powershell
npx vitest run src/lib/reader/__tests__/terminal-cli.test.ts src/lib/reader/__tests__/terminal-epub.test.ts src/lib/reader/__tests__/terminal-progress.test.ts src/lib/reader/__tests__/terminal-format.test.ts
npx tsc --noEmit --pretty false
npx eslint scripts/read.ts src/lib/reader/terminal-cli.ts src/lib/reader/terminal-epub.ts src/lib/reader/__tests__/terminal-cli.test.ts src/lib/reader/__tests__/terminal-epub.test.ts
git diff --check
```

- [ ] **Step 2: Update handoff files**

Record:

- `FEAT-004` status.
- Commands run and pass/fail results.
- Manual smoke results and any residual gaps.

- [ ] **Step 3: Commit scoped changes**

Only stage local EPUB reader files and handoff updates. Do not stage existing Worker/LLM dirty files.

```powershell
git add -- package.json scripts/read.ts src/lib/reader/terminal-cli.ts src/lib/reader/terminal-epub.ts src/lib/reader/__tests__/terminal-cli.test.ts src/lib/reader/__tests__/terminal-epub.test.ts docs/superpowers/plans/2026-06-16-local-epub-terminal-reader.md AI_SESSION_ENTRY.md AI_HANDOFF_SUMMARY.md AI_TASK_BOARD.md
git commit -m "feat: add local epub terminal reader"
```
