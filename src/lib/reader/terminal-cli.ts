export interface TerminalReaderArgs {
  bookId?: string;
  envFile?: string;
  langs: string;
  chapterIndex?: number;
  listBooks: boolean;
  showHelp: boolean;
}

export const TERMINAL_READER_USAGE =
  "Usage: npm run read -- --book <bookId> [--langs auto|ja,zh,en] [--chapter 3] [--env .env.worker] | npm run books";

export const TERMINAL_READER_HELP = `${TERMINAL_READER_USAGE}

Commands:
  npm run read:help
      Show this help. Use this instead of npm run read -- --help because npm
      handles --help itself unless you pass an extra --.

  npm run books
      List books from .env.worker.

  npm run read:worker -- <bookId>
      Open one book from .env.worker.

  npm run read -- --book <bookId> --langs auto
      Open one book using .env.local, falling back to .env.

Options:
  --book <bookId>       Book id to open.
  --langs <mode>        auto, source lang only, or comma list like ja,zh,en.
  --chapter <number>    Open a one-based chapter number.
  --env <file>          Load a specific env file, for example .env.worker.
  --list                List books instead of opening one.
  --help, -h            Show this help.

Reader keys:
  n / p                 Next / previous page.
  ] / [                 Next / previous chapter.
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

export function parseTerminalReaderArgs(argv: string[]): TerminalReaderArgs {
  const showHelp = argv.includes("--help") || argv.includes("-h");
  const listBooks = argv.includes("--list") || argv.includes("list");
  const explicitEnvFile = getArgValue(argv, "--env");
  const rawPositional = positionalArgs(argv);
  const positionalEnvFile = isEnvFileValue(rawPositional[0])
    ? rawPositional[0]
    : undefined;
  const envFile = explicitEnvFile ?? positionalEnvFile;
  const positional = positionalEnvFile
    ? rawPositional.slice(1)
    : rawPositional;
  const bookId = showHelp ? undefined : getArgValue(argv, "--book") ?? positional[0];
  if (showHelp) {
    return {
      bookId,
      envFile,
      langs: "auto",
      chapterIndex: undefined,
      listBooks,
      showHelp,
    };
  }
  if (!bookId && !listBooks) throw new Error(TERMINAL_READER_USAGE);

  const positionalLangs = isChapterValue(positional[1]) ? undefined : positional[1];
  const positionalChapter = isChapterValue(positional[1])
    ? positional[1]
    : positional[2];
  const chapterRaw = getArgValue(argv, "--chapter") ?? positionalChapter;
  const chapterNumber = chapterRaw ? Number.parseInt(chapterRaw, 10) : undefined;

  return {
    bookId,
    envFile,
    langs: getArgValue(argv, "--langs") ?? positionalLangs ?? "auto",
    chapterIndex: chapterNumber
      ? Math.max(0, chapterNumber - 1)
      : undefined,
    listBooks,
    showHelp,
  };
}
