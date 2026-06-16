import path from "path";
import { describe, expect, it } from "vitest";
import {
  loadTerminalEpub,
  progressKeyForEpubPath,
} from "@/lib/reader/terminal-epub";

function fixturePath(): string {
  return path.join(
    process.cwd(),
    "src/lib/epub/__tests__/fixtures/test.epub",
  );
}

describe("terminal EPUB loader", () => {
  it("loads a local EPUB fixture as original-text terminal chapters", async () => {
    const book = await loadTerminalEpub(fixturePath());

    expect(book.progressKey).toMatch(/^epub:[0-9a-f]{16}$/);
    expect(book.path).toBe(path.resolve(fixturePath()));
    expect(book.title).toBeTruthy();
    expect(book.author).toBeTruthy();
    expect(book.sourceLang).toBeTruthy();
    expect(book.chapters.length).toBeGreaterThan(0);
    expect(book.chapters[0]).toMatchObject({
      id: "epub-chapter-0",
      index: 0,
      title: expect.any(String),
    });
    expect(book.chapters[0].paragraphs.length).toBeGreaterThan(0);
    expect(book.chapters[0].paragraphs[0]).toMatchObject({
      seq: 1,
      kind: "text",
      sourceLang: expect.any(String),
      sourceText: expect.any(String),
      translations: {},
    });
    expect(book.chapters[0].paragraphs[0].sourceText).not.toContain("&#x");
  });

  it("uses a stable progress key for the resolved absolute EPUB path", () => {
    const absolute = path.resolve(fixturePath());

    expect(progressKeyForEpubPath(fixturePath())).toBe(
      progressKeyForEpubPath(absolute),
    );
  });

  it("throws a concise error when the EPUB file is missing", async () => {
    const missing = path.join(process.cwd(), "missing-book.epub");

    await expect(loadTerminalEpub(missing)).rejects.toThrow(
      `EPUB file not found: ${path.resolve(missing)}`,
    );
  });
});
