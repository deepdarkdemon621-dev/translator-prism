import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadTerminalProgress,
  saveTerminalProgress,
} from "@/lib/reader/terminal-progress";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "terminal-progress-"));
  tempDirs.push(dir);
  return dir;
}

function progressPath(dataDir: string): string {
  return path.join(dataDir, "terminal-progress.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("terminal progress persistence", () => {
  it("returns default progress when the file is missing", () => {
    const dataDir = makeTempDir();

    expect(loadTerminalProgress("book-1", { dataDir })).toEqual({
      chapterIndex: 0,
      page: 0,
      langs: "auto",
    });
  });

  it("saves progress and reloads it", () => {
    const dataDir = makeTempDir();

    saveTerminalProgress(
      "book-1",
      { chapterIndex: 3, page: 12, langs: "ja,zh" },
      { dataDir },
    );

    expect(loadTerminalProgress("book-1", { dataDir })).toEqual({
      chapterIndex: 3,
      page: 12,
      langs: "ja,zh",
    });
  });

  it("preserves another book entry when saving", () => {
    const dataDir = makeTempDir();

    saveTerminalProgress(
      "book-1",
      { chapterIndex: 1, page: 2, langs: "auto" },
      { dataDir },
    );
    saveTerminalProgress(
      "book-2",
      { chapterIndex: 4, page: 8, langs: "zh,en" },
      { dataDir },
    );

    expect(loadTerminalProgress("book-1", { dataDir })).toEqual({
      chapterIndex: 1,
      page: 2,
      langs: "auto",
    });
    expect(loadTerminalProgress("book-2", { dataDir })).toEqual({
      chapterIndex: 4,
      page: 8,
      langs: "zh,en",
    });
  });

  it("recovers from a corrupt file by returning defaults and overwriting safely", () => {
    const dataDir = makeTempDir();
    writeFileSync(progressPath(dataDir), "{not json", "utf8");

    expect(loadTerminalProgress("book-1", { dataDir })).toEqual({
      chapterIndex: 0,
      page: 0,
      langs: "auto",
    });

    saveTerminalProgress(
      "book-1",
      { chapterIndex: 2, page: 5, langs: "en" },
      { dataDir },
    );

    expect(JSON.parse(readFileSync(progressPath(dataDir), "utf8"))).toEqual({
      "book-1": { chapterIndex: 2, page: 5, langs: "en" },
    });
  });
});
