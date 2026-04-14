import { describe, it, expect, vi, beforeEach } from "vitest";
import { TranslationQueue } from "../translation-queue";
import type { LLMProvider, TranslationResult } from "../../llm/types";

function createMockProvider(): LLMProvider {
  return {
    name: "mock",
    translate: vi.fn().mockResolvedValue({
      text: "translated text",
      tokensUsed: 100,
      model: "mock-model",
    } satisfies TranslationResult),
  };
}

describe("TranslationQueue", () => {
  it("should process a translation job", async () => {
    const provider = createMockProvider();
    const queue = new TranslationQueue(provider, { concurrency: 1 });
    const onComplete = vi.fn();

    queue.add({
      translationId: "t1",
      text: "テスト",
      fromLang: "ja",
      toLang: "zh",
      onComplete,
      onError: vi.fn(),
    });

    await queue.onIdle();

    expect(provider.translate).toHaveBeenCalledWith("テスト", "ja", "zh", undefined);
    expect(onComplete).toHaveBeenCalledWith({
      text: "translated text",
      tokensUsed: 100,
      model: "mock-model",
    });
  });

  it("should call onError when translation fails", async () => {
    const provider = createMockProvider();
    (provider.translate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API error"));

    const queue = new TranslationQueue(provider, { concurrency: 1 });
    const onError = vi.fn();

    queue.add({
      translationId: "t2",
      text: "テスト",
      fromLang: "ja",
      toLang: "en",
      onComplete: vi.fn(),
      onError,
    });

    await queue.onIdle();

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("should respect concurrency limit", async () => {
    const provider = createMockProvider();
    let concurrent = 0;
    let maxConcurrent = 0;

    (provider.translate as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 50));
      concurrent--;
      return { text: "ok", tokensUsed: 10, model: "m" };
    });

    const queue = new TranslationQueue(provider, { concurrency: 2 });

    for (let i = 0; i < 6; i++) {
      queue.add({
        translationId: `t${i}`,
        text: "テスト",
        fromLang: "ja",
        toLang: "zh",
        onComplete: vi.fn(),
        onError: vi.fn(),
      });
    }

    await queue.onIdle();

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
