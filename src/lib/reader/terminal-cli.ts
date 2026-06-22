export interface TerminalReaderArgs {
  bookId?: string;
  epubPath?: string;
  envFile?: string;
  langs: string;
  chapterIndex?: number;
  listBooks: boolean;
  showHelp: boolean;
}

export const TERMINAL_READER_USAGE =
  "Usage: npm run read -- --book <bookId> [--langs auto|ja,zh,en] [--chapter 3] [--env .env.worker] | npm run read:epub -- <path> | npm run books";

export const TERMINAL_READER_HELP = `${TERMINAL_READER_USAGE}

Commands:
  npm run read:help
      Show this help. Use this instead of npm run read -- --help because npm
      handles --help itself unless you pass an extra --.

  npm run books
      List books from .env.worker.

  npm run read:worker -- <bookId>
      Open one book from .env.worker.

  npm run read:epub -- <path>
      Open a local EPUB file directly with automatic resume.

  npm run read -- --book <bookId> --langs auto
      Open one book using .env.local, falling back to .env.

  npm run read -- --epub <path>
      Open a local EPUB file directly without DB, upload, or translation.

Options:
  --book <bookId>       Book id to open.
  --epub <path>         Local EPUB file path to open directly.
  --langs <mode>        auto, source lang only, or comma list like ja,zh,en.
  --chapter <number>    Open a one-based chapter number.
  --env <file>          Load a specific env file, for example .env.worker.
  --list                List books instead of opening one.
  --help, -h            Show this help.

Reader keys:
  n / p, arrows         Next / previous page. Down/Right go next; Up/Left go previous.
  ] / [                 Next / previous chapter.
  t                     Table of contents / chapter jump for EPUB mode.
  1 / 2 / 3 / 4         Source / bilingual / trilingual / auto language mode.
  q                     Quit.`;

function getArgValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];

  const prefix = `${name}=`;
  const equalArg = argv.find((arg) => arg.startsWith(prefix));
  if (equalArg) return equalArg.slice(prefix.length);

  return undefined;
}

function positionalArgs(argv: string[]): string[] {
  return argv.filter((arg) => !arg.startsWith("--"));
}

function isChapterValue(value: string | undefined): boolean {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function isEnvFileValue(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith(".env");
}

function isEpubPathValue(value: string | undefined): boolean {
  return typeof value === "string" && value.toLowerCase().endsWith(".epub");
}

export function parseTerminalReaderArgs(argv: string[]): TerminalReaderArgs {
  const showHelp = argv.includes("--help") || argv.includes("-h");
  const listBooks = argv.includes("--list") || argv.includes("list");
  const explicitEnvFile = getArgValue(argv, "--env");
  const explicitEpubPath = getArgValue(argv, "--epub");
  const rawPositional = positionalArgs(argv);
  const positionalEnvFile = isEnvFileValue(rawPositional[0])
    ? rawPositional[0]
    : undefined;
  const positionalAfterEnv = positionalEnvFile
    ? rawPositional.slice(1)
    : rawPositional;
  const positionalEpubPath = isEpubPathValue(positionalAfterEnv[0])
    ? positionalAfterEnv[0]
    : undefined;
  const envFile = explicitEnvFile ?? positionalEnvFile;
  const epubPath = explicitEpubPath ?? positionalEpubPath;
  const positional = positionalEpubPath
    ? positionalAfterEnv.slice(1)
    : positionalAfterEnv;
  const bookId = showHelp || epubPath
    ? undefined
    : getArgValue(argv, "--book") ?? positional[0];
  if (showHelp) {
    return {
      bookId,
      epubPath,
      envFile,
      langs: "auto",
      chapterIndex: undefined,
      listBooks,
      showHelp,
    };
  }
  if (!bookId && !epubPath && !listBooks) throw new Error(TERMINAL_READER_USAGE);

  const positionalLangs = isChapterValue(positional[1]) ? undefined : positional[1];
  const positionalChapter = isChapterValue(positional[1])
    ? positional[1]
    : positional[2];
  const chapterRaw = getArgValue(argv, "--chapter") ?? positionalChapter;
  const chapterNumber = chapterRaw ? Number.parseInt(chapterRaw, 10) : undefined;

  return {
    bookId,
    epubPath,
    envFile,
    langs: getArgValue(argv, "--langs") ?? positionalLangs ?? "auto",
    chapterIndex: chapterNumber
      ? Math.max(0, chapterNumber - 1)
      : undefined,
    listBooks,
    showHelp,
  };
}
