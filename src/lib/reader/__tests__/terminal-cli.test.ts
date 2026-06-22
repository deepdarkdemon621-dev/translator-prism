import { describe, expect, it } from "vitest";
import {
  parseTerminalReaderArgs,
  TERMINAL_READER_HELP,
} from "@/lib/reader/terminal-cli";

describe("terminal reader CLI args", () => {
  it("allows --help without a book id", () => {
    expect(parseTerminalReaderArgs(["--help"])).toEqual({
      bookId: undefined,
      epubPath: undefined,
      envFile: undefined,
      langs: "auto",
      chapterIndex: undefined,
      listBooks: false,
      showHelp: true,
    });
  });

  it("documents listing, opening, and navigation commands", () => {
    expect(TERMINAL_READER_HELP).toContain("npm run read:help");
    expect(TERMINAL_READER_HELP).toContain("npm run books");
    expect(TERMINAL_READER_HELP).toContain("npm run read:worker -- <bookId>");
    expect(TERMINAL_READER_HELP).toContain("npm run read:epub --");
    expect(TERMINAL_READER_HELP).toContain("--epub <path>");
    expect(TERMINAL_READER_HELP).toContain("automatic resume");
    expect(TERMINAL_READER_HELP).toContain("t");
    expect(TERMINAL_READER_HELP).toContain("n / p, arrows");
    expect(TERMINAL_READER_HELP).toContain("Down/Right go next");
    expect(TERMINAL_READER_HELP).toContain("] / [");
    expect(TERMINAL_READER_HELP).toContain("1 / 2 / 3 / 4");
  });

  it("requires a book id", () => {
    expect(() => parseTerminalReaderArgs([])).toThrow(
      "Usage: npm run read -- --book <bookId>",
    );
  });

  it("allows listing books without a book id", () => {
    expect(parseTerminalReaderArgs(["--list", "--env", ".env.worker"])).toEqual({
      bookId: undefined,
      epubPath: undefined,
      envFile: ".env.worker",
      langs: "auto",
      chapterIndex: undefined,
      listBooks: true,
      showHelp: false,
    });
  });

  it("parses optional language mode and one-based chapter number", () => {
    expect(
      parseTerminalReaderArgs([
        "--book",
        "book-1",
        "--langs",
        "ja,zh,en",
        "--chapter",
        "3",
      ]),
    ).toEqual({
      bookId: "book-1",
      epubPath: undefined,
      envFile: undefined,
      langs: "ja,zh,en",
      chapterIndex: 2,
      listBooks: false,
      showHelp: false,
    });
  });

  it("supports npm positional fallback when Windows npm strips option names", () => {
    expect(parseTerminalReaderArgs(["book-1", "ja,zh", "3"])).toEqual({
      bookId: "book-1",
      epubPath: undefined,
      envFile: undefined,
      langs: "ja,zh",
      chapterIndex: 2,
      listBooks: false,
      showHelp: false,
    });
  });

  it("treats a numeric second positional arg as a chapter number", () => {
    expect(parseTerminalReaderArgs(["book-1", "3"])).toEqual({
      bookId: "book-1",
      epubPath: undefined,
      envFile: undefined,
      langs: "auto",
      chapterIndex: 2,
      listBooks: false,
      showHelp: false,
    });
  });

  it("supports env-file positional fallback when Windows npm strips option names", () => {
    expect(parseTerminalReaderArgs([".env.worker", "book-1", "ja,zh"])).toEqual({
      bookId: "book-1",
      epubPath: undefined,
      envFile: ".env.worker",
      langs: "ja,zh",
      chapterIndex: undefined,
      listBooks: false,
      showHelp: false,
    });
  });

  it("defaults to auto language mode", () => {
    expect(parseTerminalReaderArgs(["--book", "book-1"])).toEqual({
      bookId: "book-1",
      epubPath: undefined,
      envFile: undefined,
      langs: "auto",
      chapterIndex: undefined,
      listBooks: false,
      showHelp: false,
    });
  });

  it("parses an explicit local EPUB path", () => {
    expect(parseTerminalReaderArgs(["--epub", "D:\\Books\\book.epub"])).toEqual({
      bookId: undefined,
      epubPath: "D:\\Books\\book.epub",
      envFile: undefined,
      langs: "auto",
      chapterIndex: undefined,
      listBooks: false,
      showHelp: false,
    });
  });

  it("treats a positional EPUB path as local EPUB mode", () => {
    expect(parseTerminalReaderArgs(["D:\\Books\\book.epub"])).toEqual({
      bookId: undefined,
      epubPath: "D:\\Books\\book.epub",
      envFile: undefined,
      langs: "auto",
      chapterIndex: undefined,
      listBooks: false,
      showHelp: false,
    });
  });
});
