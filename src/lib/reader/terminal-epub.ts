import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { parseEpub } from "@/lib/epub/parser";
import type { TerminalParagraph } from "@/lib/reader/terminal-format";

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

export function progressKeyForEpubPath(epubPath: string): string {
  const resolved = path.resolve(epubPath);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  return `epub:${hash}`;
}

function imageLabel(alt: string | undefined): string {
  const trimmed = alt?.trim();
  return trimmed ? `[image: ${trimmed}]` : "[image]";
}

export async function loadTerminalEpub(epubPath: string): Promise<TerminalEpubBook> {
  const resolvedPath = path.resolve(epubPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`EPUB file not found: ${resolvedPath}`);
  }

  let parsed;
  try {
    parsed = await parseEpub(readFileSync(resolvedPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read EPUB: ${message}`);
  }

  const sourceLang = parsed.language || "en";
  const chapters = parsed.chapters
    .map((chapter, chapterIndex) => ({
      id: `epub-chapter-${chapterIndex}`,
      index: chapterIndex,
      title: chapter.title,
      paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) => ({
        seq: paragraphIndex + 1,
        kind: paragraph.kind,
        sourceLang,
        sourceText:
          paragraph.kind === "image"
            ? imageLabel(paragraph.alt)
            : paragraph.text,
        translations: {},
      })),
    }))
    .filter((chapter) => chapter.paragraphs.length > 0);

  if (chapters.length === 0) {
    throw new Error(`EPUB has no readable content: ${resolvedPath}`);
  }

  return {
    progressKey: progressKeyForEpubPath(resolvedPath),
    path: resolvedPath,
    title: parsed.title,
    author: parsed.author,
    sourceLang,
    chapters,
  };
}
