import { describe, expect, it } from "vitest";
import { tokenizeContentWords, lemmasForText } from "../tokenize";

// kuromoji loads a 12MB dictionary on first use — allow generous time.
const SLOW = { timeout: 60000 };

describe("tokenizeContentWords", () => {
  it("extracts content words with correct spans and lemmas", SLOW, async () => {
    const text = "堀北は学校へ行った。";
    const tokens = await tokenizeContentWords(text);
    const surfaces = tokens.map((t) => text.slice(t.start, t.end));
    // Particles (は/へ), auxiliary (た), punctuation are not content words.
    expect(surfaces).toContain("学校");
    expect(surfaces).toContain("行っ");
    expect(surfaces).not.toContain("は");
    expect(surfaces).not.toContain("。");
    const iku = tokens.find((t) => t.surface === "行っ");
    expect(iku?.lemma).toBe("行く");
    // Spans index the original string exactly.
    for (const t of tokens) {
      expect(text.slice(t.start, t.end)).toBe(t.surface);
    }
  });

  it("skips numbers and dependent forms", SLOW, async () => {
    const text = "３人がいることを見ている。";
    const tokens = await tokenizeContentWords(text);
    const lemmas = tokens.map((t) => t.lemma);
    expect(lemmas).not.toContain("３");
    // こと (dependent noun) and いる after て (dependent verb) are excluded.
    expect(lemmas).not.toContain("こと");
    expect(lemmas).toContain("見る");
  });

  it("returns unique lemmas for corpus indexing", SLOW, async () => {
    const lemmas = await lemmasForText("行く。また行く。学校に行く。");
    expect(lemmas.filter((l) => l === "行く")).toHaveLength(1);
    expect(lemmas).toContain("学校");
  });

  it("handles empty input", async () => {
    expect(await tokenizeContentWords("")).toEqual([]);
  });
});
