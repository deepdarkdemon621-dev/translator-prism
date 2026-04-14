import { describe, it, expect } from "vitest";
import { detectDictFormat } from "../format-detect";

describe("detectDictFormat", () => {
  it("identifies CC-CEDICT by header comment", () => {
    const sample = "# CC-CEDICT\n# Community maintained\n你好 你好 [ni3 hao3] /hello/";
    const info = detectDictFormat(sample);
    expect(info?.format).toBe("cedict");
    expect(info?.sourceLang).toBe("zh");
  });

  it("identifies CC-CEDICT by entry line alone", () => {
    const sample = "你好 你好 [ni3 hao3] /hello/hi/\n学习 学习 [xue2 xi2] /to learn/";
    expect(detectDictFormat(sample)?.format).toBe("cedict");
  });

  it("identifies JMdict by root tag", () => {
    const sample = `<?xml version="1.0"?><JMdict><entry><k_ele><keb>行く</keb></k_ele></entry></JMdict>`;
    const info = detectDictFormat(sample);
    expect(info?.format).toBe("jmdict");
    expect(info?.sourceLang).toBe("ja");
  });

  it("identifies JMdict by DOCTYPE", () => {
    const sample = `<?xml version="1.0"?><!DOCTYPE JMdict [<!ENTITY v5k-s "godan">]><JMdict>`;
    expect(detectDictFormat(sample)?.format).toBe("jmdict");
  });

  it("returns null for unknown format", () => {
    expect(detectDictFormat("random garbage content")).toBeNull();
    expect(detectDictFormat("")).toBeNull();
  });
});
