import { describe, expect, it } from "vitest";
import {
  normalizeTerminalLangs,
  paginateParagraphs,
  renderParagraphBlock,
  stripHtmlForTerminal,
  type TerminalParagraph,
} from "@/lib/reader/terminal-format";

describe("terminal reader formatting", () => {
  it("normalizes auto languages with the source first and translations in reader order", () => {
    expect(
      normalizeTerminalLangs({
        requested: undefined,
        sourceLang: "zh",
        availableLangs: ["en", "ja"],
      }),
    ).toEqual(["zh", "ja", "en"]);

    expect(
      normalizeTerminalLangs({
        requested: " AUTO ",
        sourceLang: "en",
        availableLangs: ["zh", "ja"],
      }),
    ).toEqual(["en", "ja", "zh"]);
  });

  it("keeps requested order while removing duplicates, unknowns, and unavailable translations", () => {
    expect(
      normalizeTerminalLangs({
        requested: "EN,xx,JA,en,ZH",
        sourceLang: "ja",
        availableLangs: ["en", "zh"],
      }),
    ).toEqual(["en", "ja", "zh"]);

    expect(
      normalizeTerminalLangs({
        requested: "xx,zh",
        sourceLang: "en",
        availableLangs: ["ja"],
      }),
    ).toEqual(["en"]);
  });

  it("renders a vertical trilingual text block", () => {
    const paragraph: TerminalParagraph = {
      seq: 7,
      kind: "text",
      sourceLang: "ja",
      sourceText: "Original",
      translations: {
        zh: { text: "Traditional", status: "done" },
        en: { text: "English", status: "done" },
      },
    };

    expect(renderParagraphBlock(paragraph, ["ja", "zh", "en"])).toBe(
      "[7]\nJA  Original\nZH  Traditional\nEN  English",
    );
  });

  it("renders pending translation status when text is not done", () => {
    const paragraph: TerminalParagraph = {
      seq: 2,
      kind: "text",
      sourceLang: "en",
      sourceText: "Waiting",
      translations: {
        ja: { text: null, status: "pending" },
      },
    };

    expect(renderParagraphBlock(paragraph, ["en", "ja"])).toBe(
      "[2]\nEN  Waiting\nJA  [pending]",
    );
  });

  it("renders images with an image marker", () => {
    const paragraph: TerminalParagraph = {
      seq: 3,
      kind: "image",
      sourceLang: "en",
      sourceText: "",
      translations: {},
    };

    expect(renderParagraphBlock(paragraph, ["en", "ja"])).toBe(
      "[3]\nIMG [image]",
    );
  });

  it("strips HTML tags, script/style content, entities, and extra whitespace", () => {
    expect(
      stripHtmlForTerminal(
        "<style>.x{}</style><p>Hello&nbsp;<strong>&amp;</strong> &lt;world&gt;</p><script>alert(1)</script>&quot;ok&#39;",
      ),
    ).toBe('Hello & <world> "ok\'');
  });

  it("paginates paragraphs with a non-negative page start", () => {
    const paragraphs: TerminalParagraph[] = [
      { seq: 1, kind: "text", sourceLang: "en", sourceText: "One", translations: {} },
      { seq: 2, kind: "text", sourceLang: "en", sourceText: "Two", translations: {} },
      { seq: 3, kind: "text", sourceLang: "en", sourceText: "Three", translations: {} },
      { seq: 4, kind: "text", sourceLang: "en", sourceText: "Four", translations: {} },
    ];

    expect(paginateParagraphs(paragraphs, 1, 2).map((paragraph) => paragraph.seq)).toEqual([
      3,
      4,
    ]);
    expect(paginateParagraphs(paragraphs, -2, 2).map((paragraph) => paragraph.seq)).toEqual([
      1,
      2,
    ]);
  });
});
