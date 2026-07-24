import { describe, expect, it } from "vitest";
import { CliOutputError } from "../cli-output";
import {
  runBatchWithSplitRetry,
  validateBatchResults,
} from "../translation-validation";
import type { ChapterBatchRequest, TranslationBatchResult } from "../types";

function makeInput(overrides: {
  expected?: { id: string; sourceText: string }[];
  results?: { id: string; text: string }[];
  sourceLang?: string;
  targetLang?: string;
}) {
  return {
    expected: overrides.expected ?? [{ id: "a", sourceText: "彼はゆっくりと扉を開けた。" }],
    results: overrides.results ?? [{ id: "a", text: "他缓缓地打开了门。" }],
    sourceLang: overrides.sourceLang ?? "ja",
    targetLang: overrides.targetLang ?? "zh",
  };
}

describe("validateBatchResults", () => {
  it("accepts a normal translation", () => {
    const result = validateBatchResults(makeInput({}));
    expect(result.accepted.map((a) => a.id)).toEqual(["a"]);
    expect(result.rejected).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("drops unknown ids without failing valid siblings", () => {
    const result = validateBatchResults(
      makeInput({
        results: [
          { id: "a", text: "他缓缓地打开了门。" },
          { id: "ghost", text: "多余" },
        ],
      }),
    );
    expect(result.accepted.map((a) => a.id)).toEqual(["a"]);
    expect(result.unknown).toEqual(["ghost"]);
  });

  it("rejects duplicate ids entirely", () => {
    const result = validateBatchResults(
      makeInput({
        results: [
          { id: "a", text: "版本一" },
          { id: "a", text: "版本二" },
        ],
      }),
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ id: "a" });
    expect(result.rejected[0].reasons).toContain("duplicate_id");
  });

  it("rejects empty text and reports absent ids as missing", () => {
    const result = validateBatchResults(
      makeInput({
        expected: [
          { id: "a", sourceText: "彼は言った。" },
          { id: "b", sourceText: "彼女は笑った。" },
          { id: "c", sourceText: "夜が明けた。" },
        ],
        results: [
          { id: "a", text: "" },
          { id: "b", text: "她笑了。" },
        ],
      }),
    );
    expect(result.rejected[0]).toMatchObject({ id: "a" });
    expect(result.rejected[0].reasons).toContain("empty_text");
    expect(result.accepted.map((a) => a.id)).toEqual(["b"]);
    expect(result.missing).toEqual(["c"]);
  });

  it("rejects a source copy when the source contains kana", () => {
    const result = validateBatchResults(
      makeInput({
        expected: [{ id: "a", sourceText: "彼はゆっくりと扉を開けた。" }],
        results: [{ id: "a", text: "彼はゆっくりと扉を開けた。" }],
      }),
    );
    expect(result.rejected[0].reasons).toContain("source_copy");
  });

  it("accepts identical output for kanji-only names with a warning", () => {
    const result = validateBatchResults(
      makeInput({
        expected: [{ id: "a", sourceText: "山田太郎" }],
        results: [{ id: "a", text: "山田太郎" }],
      }),
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].warnings).toContain("source_copy");
  });

  it("accepts identical punctuation-only output without warnings", () => {
    const result = validateBatchResults(
      makeInput({
        expected: [{ id: "a", sourceText: "……" }],
        results: [{ id: "a", text: "……" }],
      }),
    );
    expect(result.accepted[0].warnings).toEqual([]);
  });

  it("rejects markdown fences and explanatory prefixes", () => {
    const result = validateBatchResults(
      makeInput({
        expected: [
          { id: "a", sourceText: "彼は言った。" },
          { id: "b", sourceText: "彼女は笑った。" },
        ],
        results: [
          { id: "a", text: "```json\n他说。\n```" },
          { id: "b", text: "以下是翻译:她笑了。" },
        ],
      }),
    );
    expect(result.rejected.find((r) => r.id === "a")?.reasons).toContain(
      "markdown_fence",
    );
    expect(result.rejected.find((r) => r.id === "b")?.reasons).toContain(
      "explanatory_prefix",
    );
  });

  it("rejects obvious refusal text", () => {
    const result = validateBatchResults(
      makeInput({
        results: [{ id: "a", text: "I'm sorry, I can't translate this content." }],
      }),
    );
    expect(result.rejected[0].reasons).toContain("refusal");
  });

  it("warns instead of rejecting on unusual length ratio", () => {
    const longSource = "長い夜だった。".repeat(20);
    const result = validateBatchResults(
      makeInput({
        expected: [{ id: "a", sourceText: longSource }],
        results: [{ id: "a", text: "短。" }],
      }),
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].warnings).toContain("length_ratio");
  });

  it("warns instead of rejecting when target retains source-script characters", () => {
    const result = validateBatchResults(
      makeInput({
        expected: [{ id: "a", sourceText: "彼はワインを飲んだ。" }],
        results: [{ id: "a", text: "他喝了ワイン。" }],
        targetLang: "zh",
      }),
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].warnings).toContain("residual_source_script");
  });
});

describe("runBatchWithSplitRetry", () => {
  const request = (ids: string[]): ChapterBatchRequest => ({
    bookTitle: "B",
    chapterTitle: "C",
    sourceLang: "ja",
    targetLang: "zh",
    items: ids.map((id, seq) => ({ id, seq, text: `原文${id}` })),
  });

  const okResult = (id: string): TranslationBatchResult => ({
    id,
    text: `译文${id}`,
    tokensUsed: 1,
    model: "claude-code:sonnet",
  });

  it("returns full-batch results without splitting on success", async () => {
    const calls: number[] = [];
    const outcome = await runBatchWithSplitRetry(
      request(["a", "b"]),
      async (req) => {
        calls.push(req.items.length);
        return req.items.map((item) => okResult(item.id));
      },
    );
    expect(calls).toEqual([2]);
    expect(outcome.results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(outcome.failures).toEqual([]);
  });

  it("splits on whole-batch invalid output and salvages both halves", async () => {
    const calls: number[] = [];
    const outcome = await runBatchWithSplitRetry(
      request(["a", "b", "c", "d"]),
      async (req) => {
        calls.push(req.items.length);
        if (req.items.length > 2) throw new CliOutputError("bad json");
        return req.items.map((item) => okResult(item.id));
      },
    );
    expect(calls).toEqual([4, 2, 2]);
    expect(outcome.results.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(outcome.failures).toEqual([]);
  });

  it("records invalid_output failures at one item without further splitting", async () => {
    const outcome = await runBatchWithSplitRetry(
      request(["a", "b"]),
      async (req) => {
        if (req.items.some((item) => item.id === "a")) {
          if (req.items.length === 1) throw new CliOutputError("still bad");
          throw new CliOutputError("bad json");
        }
        return req.items.map((item) => okResult(item.id));
      },
    );
    expect(outcome.results.map((r) => r.id)).toEqual(["b"]);
    expect(outcome.failures).toEqual([
      { id: "a", code: "invalid_output", message: "still bad" },
    ]);
  });

  it("stops splitting at the maximum depth", async () => {
    const calls: number[] = [];
    const outcome = await runBatchWithSplitRetry(
      request(Array.from({ length: 8 }, (_, i) => `p${i}`)),
      async (req) => {
        calls.push(req.items.length);
        throw new CliOutputError("always bad");
      },
      { maxDepth: 2 },
    );
    // Depth-first: 8 → first half (4 → 2, 2) → second half (4 → 2, 2).
    // No depth-3 single-item calls because maxDepth is 2.
    expect(calls).toEqual([8, 4, 2, 2, 4, 2, 2]);
    expect(outcome.results).toEqual([]);
    expect(outcome.failures).toHaveLength(8);
    expect(outcome.failures.every((f) => f.code === "invalid_output")).toBe(true);
  });

  it("propagates non-parse errors without splitting", async () => {
    const calls: number[] = [];
    await expect(
      runBatchWithSplitRetry(request(["a", "b"]), async (req) => {
        calls.push(req.items.length);
        throw new Error("CLI process timed out after 120000ms");
      }),
    ).rejects.toThrow(/timed out/);
    expect(calls).toEqual([2]);
  });
});
