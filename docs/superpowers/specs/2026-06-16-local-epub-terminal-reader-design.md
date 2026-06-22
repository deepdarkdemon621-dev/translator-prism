# Local EPUB Terminal Reader Design

## Objective

Add a local-only terminal reading mode for EPUB files that are already on the user's machine.

The reader must open a user-specified `.epub` file directly, render the original text in the terminal, support page and chapter navigation, show a table of contents for jumping, and automatically resume from the last read position. It must not import the book into the application database, access Turso, load worker environment files, upload files, or trigger translation.

## Non-Goals

- No local library indexing, directory scanning, search, or book management.
- No translation, translation status display, pricing, upload, or worker behavior.
- No DB writes to `books`, `chapters`, `paragraphs`, or `reading_progress`.
- No terminal image rendering. Image rows can render as `[image]` or `[image: alt]`.
- No manual bookmark list. "Bookmark" means automatic resume from the last read position only.

## User Commands

- `npm run read:epub -- "D:\Books\book.epub"`
- `npm run read -- --epub "D:\Books\book.epub"`
- `npm run read:help`

Help output must document the EPUB mode, including command examples and keyboard controls.

## Reader Controls

In reading mode:

- `n`, down arrow, or right arrow: next page.
- `p`, up arrow, or left arrow: previous page.
- `]`: next chapter.
- `[`: previous chapter.
- `t`: open table of contents.
- `q`: quit.

In table-of-contents mode:

- Show numbered chapter entries from the EPUB spine/TOC.
- Enter a chapter number to jump to that chapter and reset page to 1.
- Empty input or `Esc` returns to the current reading position.

## Terminal Viewport Behavior

Local EPUB mode should not depend on the host terminal scroll bar for normal reading. It should render a bounded page that fits the current terminal viewport when terminal dimensions are available.

The rendered page height must account for:

- Reader chrome: title, author, file path, chapter title, page line, blank separator, and footer controls.
- Wrapped header/footer lines, especially long local file paths.
- CJK full-width characters, which occupy two terminal columns in common Windows Terminal/PowerShell setups.
- Blank separator lines between paragraph blocks.

When terminal dimensions are unavailable, such as non-TTY smoke tests, the reader may fall back to fixed paragraph pagination.

Known limitation: if one paragraph alone is taller than the terminal viewport, it is still rendered as one block. Splitting inside a paragraph is a possible future improvement.

## Data Flow

1. CLI parses `--epub <path>` or the positional path supplied by `read:epub`.
2. The script resolves the path to an absolute local file path and reads the EPUB bytes.
3. `src/lib/epub/parser.ts` parses metadata, chapter order, chapter titles, paragraphs, and image rows.
4. A local EPUB loader maps parsed chapters into the same terminal-readable shape used by the existing terminal renderer.
5. The terminal loop renders one page of original EPUB text at a time.
6. On every page or chapter change, progress is written to `data/terminal-progress.json`.

## Progress Storage

Reuse the existing local JSON progress file.

The progress key should be deterministic and local-file specific:

- Prefix: `epub:`
- Identifier: a short hash of the resolved absolute EPUB path

The stored value only needs:

- `chapterIndex`
- `page`
- `langs`

For EPUB mode, `langs` can stay at `"source"` or `"auto"` for compatibility, but it must not cause translation lookup.

## Architecture

Keep the reading loop shared and put source-specific data access behind small loaders.

Suggested modules:

- `scripts/read.ts`
  - Handles CLI entrypoint and selects DB mode or local EPUB mode.
  - Must not load env or DB when `--epub` is used.
- `src/lib/reader/terminal-cli.ts`
  - Adds `epubPath` parsing and help text for EPUB mode.
- `src/lib/reader/terminal-epub.ts`
  - Reads a local file and returns a terminal-readable book object.
  - Reuses `parseEpub`.
  - Builds a stable progress key.
- Existing `terminal-format.ts`
  - Reused for text cleanup and source-text rendering.
- `src/lib/reader/terminal-pagination.ts`
  - Calculates row-aware terminal pages from rendered text blocks.
  - Estimates CJK full-width display width.
  - Provides fixed-size fallback when terminal dimensions are unavailable.
- `src/lib/reader/terminal-input.ts`
  - Restores raw mode and resumes stdin after line-input prompts such as TOC jumps.
- Existing `terminal-progress.ts`
  - Reused for local progress persistence.

If the current `scripts/read.ts` becomes hard to keep clear, extract the interactive rendering loop into a helper before adding EPUB mode. Keep that extraction narrow and covered by tests.

## Error Handling

- Missing path: print usage with EPUB examples.
- Non-EPUB extension: show a concise warning or error.
- Missing file: `EPUB file not found: <path>`.
- Parse failure: `Failed to read EPUB: <reason>`.
- EPUB with no chapters or no readable paragraphs: report that the file has no readable content.
- Invalid TOC input: keep the TOC open and show a concise prompt.

## Testing

Add focused tests before implementation:

- CLI parser accepts `--epub <path>` and positional `read:epub` style arguments.
- Help text documents `read:epub`, `--epub`, TOC jump, and resume behavior.
- EPUB loader reads the existing fixture EPUB and returns title, chapters, paragraphs, and a stable progress key.
- EPUB mode does not require env or DB loading. Prefer testing this by keeping the loader independent from `getDb`.
- Progress load/save works with an `epub:` progress key.
- Terminal pagination accounts for CJK full-width characters and wrapped reader chrome.
- TOC line input restores stdin so jumping does not exit the reader.

Manual smoke after implementation:

- `npm run read:help`
- `npm run read:epub -- src/lib/epub/__tests__/fixtures/test.epub`
- `npm run read:epub -- "C:\Programming\translator\test-novel\gzr.epub"`
- Turn pages, switch chapters, quit, reopen, and confirm resume.
- Press `t`, jump to a chapter, quit, reopen, and confirm the jumped position is remembered.

## Implementation Notes

- Design committed in `0a748af`.
- Initial implementation committed in `28ab422`.
- TOC stdin-resume fix committed in `5de819b`.
- Row-aware viewport pagination committed in `334a290`.
- Header/footer and CJK full-width pagination correction committed in `0a592d5`.
- Arrow-key page navigation for up/down/left/right added in the local FEAT-005 change.
