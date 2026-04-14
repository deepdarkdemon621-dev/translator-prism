import { describe, it, expect } from "vitest";
import { parseCedict, parseCedictLine } from "../cedict-parser";

describe("CC-CEDICT parser", () => {
  it("parses a simple entry", () => {
    const line = "你好 你好 [ni3 hao3] /hello/hi/";
    const entries = parseCedictLine(line);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      headword: "你好",
      reading: "ni3 hao3",
      gloss: "hello / hi",
    });
  });

  it("emits two entries when traditional differs from simplified", () => {
    const line = "學習 学习 [xue2 xi2] /to learn/to study/";
    const entries = parseCedictLine(line);
    expect(entries).toHaveLength(2);
    expect(entries[0].headword).toBe("学习");
    expect(entries[1].headword).toBe("學習");
    expect(entries[0].gloss).toBe("to learn / to study");
    expect(entries[1].reading).toBe("xue2 xi2");
  });

  it("ignores comments and blank lines", () => {
    expect(parseCedictLine("# CC-CEDICT")).toEqual([]);
    expect(parseCedictLine("")).toEqual([]);
    expect(parseCedictLine("   ")).toEqual([]);
  });

  it("ignores malformed lines", () => {
    expect(parseCedictLine("not a valid entry")).toEqual([]);
  });

  it("streams multiple lines via parseCedict", () => {
    const blob = [
      "# CC-CEDICT sample",
      "",
      "你好 你好 [ni3 hao3] /hello/",
      "學習 学习 [xue2 xi2] /to learn/",
      "再見 再见 [zai4 jian4] /goodbye/",
    ].join("\n");

    const entries = Array.from(parseCedict(blob));
    // 1 + 2 + 2 = 5 entries
    expect(entries).toHaveLength(5);
    expect(entries.map((e) => e.headword)).toEqual([
      "你好",
      "学习",
      "學習",
      "再见",
      "再見",
    ]);
  });
});
