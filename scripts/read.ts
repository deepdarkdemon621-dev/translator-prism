import { config as loadEnv } from "dotenv";
import path from "path";
import readline from "readline";
import type { ReaderLang } from "../src/lib/reader/language-selection";
import type { TerminalParagraph } from "../src/lib/reader/terminal-format";
import { restoreTerminalInput } from "../src/lib/reader/terminal-input";
import { paginateByTerminalRows } from "../src/lib/reader/terminal-pagination";
import {
  parseTerminalReaderArgs,
  TERMINAL_READER_HELP,
  type TerminalReaderArgs,
} from "../src/lib/reader/terminal-cli";

const PAGE_SIZE = 8;

function moduleExports<T>(moduleValue: T | { default: T }): T {
  if (
    typeof moduleValue === "object" &&
    moduleValue !== null &&
    "default" in moduleValue
  ) {
    return moduleValue.default as T;
  }
  return moduleValue as T;
}

function clearScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[H");
  }
}

function isTerminalReaderLang(value: string): value is ReaderLang {
  return value === "ja" || value === "zh" || value === "en";
}

function setRawMode(enabled: boolean): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(enabled);
  }
}

function nextLangMode(params: {
  count: 1 | 2 | 3;
  sourceLang: string;
  availableLangs: string[];
}): string {
  const translations = params.availableLangs.filter(
    (lang) => lang !== params.sourceLang,
  );
  return [params.sourceLang, ...translations.slice(0, params.count - 1)].join(
    ",",
  );
}

function hasExplicitLangs(
  argv: string[],
  args: TerminalReaderArgs,
): boolean {
  if (argv.includes("--langs")) return true;
  if (argv.some((arg) => arg.startsWith("--langs="))) return true;

  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const withoutEnv = args.envFile && positional[0] === args.envFile
    ? positional.slice(1)
    : positional;
  const withoutBook = args.bookId && withoutEnv[0] === args.bookId
    ? withoutEnv.slice(1)
    : withoutEnv;
  const possibleLang = withoutBook[0];
  return Boolean(
    possibleLang &&
      !/^[1-9]\d*$/.test(possibleLang) &&
      possibleLang !== "list",
  );
}

function loadEnvForReader(envFile: string | undefined): void {
  if (envFile) {
    loadEnv({ path: path.join(process.cwd(), envFile), quiet: true });
    return;
  }

  loadEnv({ path: path.join(process.cwd(), ".env.local"), quiet: true });
  loadEnv({ quiet: true });
}

async function askLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await new Promise((resolve) => {
      rl.question(prompt, resolve);
    });
  } finally {
    rl.close();
  }
}

async function runEpubReader(epubPath: string): Promise<void> {
  const { loadTerminalEpub } = moduleExports(
    await import("../src/lib/reader/terminal-epub"),
  );
  const {
    renderParagraphBlock,
    stripHtmlForTerminal,
  } = moduleExports(await import("../src/lib/reader/terminal-format"));
  const { loadTerminalProgress, saveTerminalProgress } = moduleExports(
    await import("../src/lib/reader/terminal-progress"),
  );

  const terminalBook = await loadTerminalEpub(epubPath);
  const saved = loadTerminalProgress(terminalBook.progressKey);
  let chapterIndex = Math.min(
    Math.max(0, saved.chapterIndex),
    terminalBook.chapters.length - 1,
  );
  let page = saved.page;
  let acceptingLineInput = false;

  function renderParagraph(paragraph: TerminalParagraph): string {
    if (isTerminalReaderLang(paragraph.sourceLang)) {
      return renderParagraphBlock(paragraph, [paragraph.sourceLang]);
    }

    if (paragraph.kind === "image") {
      return `[${paragraph.seq}]\nIMG ${paragraph.sourceText}`;
    }
    return `[${paragraph.seq}]\n${stripHtmlForTerminal(paragraph.sourceText)}`;
  }

  function saveProgress(): void {
    saveTerminalProgress(terminalBook.progressKey, {
      chapterIndex,
      page,
      langs: "source",
    });
  }

  function render(): void {
    const chapter = terminalBook.chapters[chapterIndex];
    const paginated = paginateByTerminalRows(chapter.paragraphs, page, {
      renderItem: renderParagraph,
      rows: process.stdout.rows,
      columns: process.stdout.columns,
      reservedRows: 9,
      separatorRows: 1,
      fallbackPageSize: PAGE_SIZE,
    });
    page = paginated.page;

    clearScreen();
    console.log("Prism Local EPUB Reader");
    console.log(`Book: ${terminalBook.title}`);
    console.log(`Author: ${terminalBook.author}`);
    console.log(`File: ${terminalBook.path}`);
    console.log(
      `Chapter ${chapter.index + 1}/${terminalBook.chapters.length}: ${chapter.title}`,
    );
    console.log(`Page ${page + 1}/${paginated.pageCount}`);
    console.log("");

    for (const paragraph of paginated.items) {
      console.log(renderParagraph(paragraph));
      console.log("");
    }

    console.log("n next | p prev | ] next chapter | [ prev chapter | t toc | q quit");
    saveProgress();
  }

  async function openToc(): Promise<void> {
    acceptingLineInput = true;
    setRawMode(false);
    try {
      console.log("");
      console.log("Table of Contents");
      for (const chapter of terminalBook.chapters) {
        console.log(`${chapter.index + 1}. ${chapter.title}`);
      }
      const answer = (await askLine("Chapter number (blank to cancel): ")).trim();
      if (answer.length > 0) {
        const selected = Number.parseInt(answer, 10);
        if (
          Number.isInteger(selected) &&
          selected >= 1 &&
          selected <= terminalBook.chapters.length
        ) {
          chapterIndex = selected - 1;
          page = 0;
        } else {
          console.log(`Invalid chapter number: ${answer}`);
          await askLine("Press Enter to return.");
        }
      }
    } finally {
      acceptingLineInput = false;
      restoreTerminalInput(process.stdin, true);
    }
    render();
  }

  render();
  if (!process.stdin.isTTY) return;

  readline.emitKeypressEvents(process.stdin);
  setRawMode(true);
  process.stdin.resume();

  process.stdin.on("keypress", (_value, key) => {
    void (async () => {
      if (acceptingLineInput) return;

      if ((key.ctrl && key.name === "c") || key.name === "q") {
        setRawMode(false);
        process.exit(0);
      }

      if (key.name === "n" || key.name === "right") page += 1;
      if (key.name === "p" || key.name === "left") page -= 1;
      if (key.sequence === "]") {
        chapterIndex = Math.min(terminalBook.chapters.length - 1, chapterIndex + 1);
        page = 0;
      }
      if (key.sequence === "[") {
        chapterIndex = Math.max(0, chapterIndex - 1);
        page = 0;
      }
      if (key.name === "t") {
        await openToc();
        return;
      }

      render();
    })().catch((error: unknown) => {
      setRawMode(true);
      console.error(error instanceof Error ? error.message : error);
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseTerminalReaderArgs(argv);
  if (args.showHelp) {
    console.log(TERMINAL_READER_HELP);
    return;
  }
  if (args.epubPath) {
    await runEpubReader(args.epubPath);
    return;
  }
  const langsProvided = hasExplicitLangs(argv, args);
  loadEnvForReader(args.envFile);

  const { getDb } = moduleExports(await import("../src/lib/db/index"));
  const {
    listTerminalBooks,
    loadTerminalBook,
    loadTerminalChapter,
    loadTerminalDbProgress,
    saveTerminalDbProgress,
  } = moduleExports(
    await import("../src/lib/reader/terminal-data"),
  );
  const {
    normalizeTerminalLangs,
    paginateParagraphs,
    renderParagraphBlock,
  } = moduleExports(await import("../src/lib/reader/terminal-format"));
  const { loadTerminalProgress, saveTerminalProgress } = moduleExports(
    await import("../src/lib/reader/terminal-progress"),
  );

  const db = getDb();
  if (args.listBooks) {
    const bookRows = await listTerminalBooks(db);
    if (bookRows.length === 0) {
      console.log("No books found.");
      return;
    }
    console.table(bookRows);
    return;
  }

  const bookId = args.bookId;
  if (!bookId) throw new Error("Book id is required");
  const terminalBookId = bookId;

  const book = await loadTerminalBook(db, terminalBookId);
  if (!book) throw new Error(`Book not found: ${args.bookId}`);
  if (book.chapters.length === 0) throw new Error("Book has no chapters");
  const terminalBook = book;

  const saved = loadTerminalProgress(terminalBookId);
  const dbProgress = await loadTerminalDbProgress(db, terminalBookId);
  const initialProgress = dbProgress ?? saved;
  let chapterIndex = Math.min(
    Math.max(0, args.chapterIndex ?? initialProgress.chapterIndex),
    terminalBook.chapters.length - 1,
  );
  let page = initialProgress.page;
  let langArg = langsProvided ? args.langs : saved.langs;
  let currentAvailableLangs: string[] = [];

  async function render(): Promise<void> {
    const chapterSummary = terminalBook.chapters[chapterIndex];
    const chapter = await loadTerminalChapter(
      db,
      chapterSummary.id,
      terminalBook.sourceLang,
    );
    if (!chapter) throw new Error(`Chapter not found: ${chapterSummary.id}`);

    currentAvailableLangs = chapter.availableLangs;
    const langs = normalizeTerminalLangs({
      requested: langArg,
      sourceLang: terminalBook.sourceLang,
      availableLangs: chapter.availableLangs,
    });
    const pages = Math.max(1, Math.ceil(chapter.paragraphs.length / PAGE_SIZE));
    page = Math.min(Math.max(0, page), pages - 1);

    clearScreen();
    console.log("Prism Terminal Reader");
    console.log(`Book: ${terminalBook.title}`);
    console.log(
      `Chapter ${chapterSummary.index + 1}/${terminalBook.chapters.length}: ${chapter.title}`,
    );
    console.log(`Page ${page + 1}/${pages}`);
    console.log(`Mode: ${langs.join(", ")}`);
    console.log("");

    for (const paragraph of paginateParagraphs(
      chapter.paragraphs,
      page,
      PAGE_SIZE,
    )) {
      console.log(renderParagraphBlock(paragraph, langs));
      console.log("");
    }

    console.log(
      "n next | p prev | ] next chapter | [ prev chapter | 1/2/3/4 mode | q quit",
    );
    const progress = { chapterIndex, page, langs: langArg };
    saveTerminalProgress(terminalBookId, progress);
    await saveTerminalDbProgress(db, terminalBookId, progress);
  }

  await render();
  if (!process.stdin.isTTY) return;

  readline.emitKeypressEvents(process.stdin);
  setRawMode(true);
  process.stdin.resume();

  process.stdin.on("keypress", (_value, key) => {
    void (async () => {
      if ((key.ctrl && key.name === "c") || key.name === "q") {
        setRawMode(false);
        process.exit(0);
      }

      if (key.name === "n" || key.name === "right") page += 1;
      if (key.name === "p" || key.name === "left") page -= 1;
      if (key.sequence === "]") {
        chapterIndex = Math.min(terminalBook.chapters.length - 1, chapterIndex + 1);
        page = 0;
      }
      if (key.sequence === "[") {
        chapterIndex = Math.max(0, chapterIndex - 1);
        page = 0;
      }
      if (key.name === "1") {
        langArg = nextLangMode({
          count: 1,
          sourceLang: terminalBook.sourceLang,
          availableLangs: currentAvailableLangs,
        });
      }
      if (key.name === "2") {
        langArg = nextLangMode({
          count: 2,
          sourceLang: terminalBook.sourceLang,
          availableLangs: currentAvailableLangs,
        });
      }
      if (key.name === "3") {
        langArg = nextLangMode({
          count: 3,
          sourceLang: terminalBook.sourceLang,
          availableLangs: currentAvailableLangs,
        });
      }
      if (key.name === "4") langArg = "auto";

      await render();
    })().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
    });
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
