import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

export interface TerminalProgress {
  chapterIndex: number;
  page: number;
  langs: string;
}

const DEFAULT_PROGRESS: TerminalProgress = {
  chapterIndex: 0,
  page: 0,
  langs: "auto",
};

interface TerminalProgressOptions {
  dataDir?: string;
}

type ProgressStore = Record<string, TerminalProgress>;

function getProgressPath(dataDir?: string): string {
  return path.join(dataDir ?? path.join(process.cwd(), "data"), "terminal-progress.json");
}

function isProgress(value: unknown): value is TerminalProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const candidate = value as Partial<TerminalProgress>;
  return (
    typeof candidate.chapterIndex === "number" &&
    typeof candidate.page === "number" &&
    typeof candidate.langs === "string"
  );
}

function readStore(progressFile: string): ProgressStore {
  if (!existsSync(progressFile)) return {};

  try {
    const parsed = JSON.parse(readFileSync(progressFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as ProgressStore;
  } catch {
    return {};
  }
}

export function loadTerminalProgress(
  bookId: string,
  options: TerminalProgressOptions = {},
): TerminalProgress {
  const store = readStore(getProgressPath(options.dataDir));
  const progress = store[bookId];

  if (!isProgress(progress)) return { ...DEFAULT_PROGRESS };
  return { ...progress };
}

export function saveTerminalProgress(
  bookId: string,
  progress: TerminalProgress,
  options: TerminalProgressOptions = {},
): void {
  const progressFile = getProgressPath(options.dataDir);
  const store = readStore(progressFile);

  store[bookId] = { ...progress };
  mkdirSync(path.dirname(progressFile), { recursive: true });
  writeFileSync(progressFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}
