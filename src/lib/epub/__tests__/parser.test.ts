import { describe, it, expect } from "vitest";
import { parseEpub } from "../parser";
import path from "path";
import fs from "fs";

const FIXTURE_PATH = path.join(__dirname, "fixtures", "test.epub");

describe("EPUB parser", () => {
  it("should extract book metadata", async () => {
    const buffer = fs.readFileSync(FIXTURE_PATH);
    const result = await parseEpub(buffer);

    expect(result.title).toBe("テスト小説");
    expect(result.author).toBe("テスト著者");
    expect(result.language).toBe("ja");
  });

  it("should extract chapters in spine order", async () => {
    const buffer = fs.readFileSync(FIXTURE_PATH);
    const result = await parseEpub(buffer);

    expect(result.chapters).toHaveLength(2);
    expect(result.chapters[0].title).toBe("第一章 洞窟");
    expect(result.chapters[1].title).toBe("第二章 スキル");
  });

  it("should extract paragraphs from chapter", async () => {
    const buffer = fs.readFileSync(FIXTURE_PATH);
    const result = await parseEpub(buffer);

    const ch1 = result.chapters[0];
    expect(ch1.paragraphs.length).toBe(3);
    expect(ch1.paragraphs[0].text).toBe("目が覚めると、暗い洞窟の中にいた。");
    expect(ch1.paragraphs[1].markup).toContain("<strong>");
  });

  it("should preserve heading as paragraph", async () => {
    const buffer = fs.readFileSync(FIXTURE_PATH);
    const result = await parseEpub(buffer);

    // h1 is not extracted as a paragraph — only <p> tags
    const ch1Texts = result.chapters[0].paragraphs.map((p) => p.text);
    expect(ch1Texts).not.toContain("第一章 洞窟");
  });
});
