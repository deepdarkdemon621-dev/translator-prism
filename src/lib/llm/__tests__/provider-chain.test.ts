import { beforeEach, describe, expect, it } from "vitest";
import {
  disabledProviders,
  ProviderChain,
  ProviderChainError,
} from "../provider-chain";
import type { LLMProvider, TranslationResult } from "../types";

describe("ProviderChain", () => {
  beforeEach(() => {
    disabledProviders.clear();
    delete process.env.CLAUDE_CODE_CONCURRENCY;
  });

  it("returns the first provider success without calling later providers", async () => {
    const first = fakeProvider("claude-code", async () => result("one"));
    let secondCalled = false;
    const second = fakeProvider("ollama", async () => {
      secondCalled = true;
      return result("two");
    });

    const chain = new ProviderChain([first, second]);

    expect(await chain.translate("hello", "en", "fr")).toMatchObject({
      text: "one",
    });
    expect(secondCalled).toBe(false);
  });

  it("skips unavailable providers without recording a failure", async () => {
    let firstCalled = false;
    const first = {
      ...fakeProvider("claude-code", async () => {
        firstCalled = true;
        throw new Error("should not be called");
      }),
      isAvailable: () => false,
    };
    const second = fakeProvider("ollama", async () => result("local"));

    const chain = new ProviderChain([first, second]);

    await expect(chain.translate("hello", "en", "fr")).resolves.toMatchObject({
      text: "local",
    });
    expect(firstCalled).toBe(false);
    expect(disabledProviders.has("claude-code")).toBe(false);
  });

  it("reports skipped unavailable providers when none can run", async () => {
    const onlyProvider = {
      ...fakeProvider("claude-code", async () => {
        throw new Error("should not be called");
      }),
      isAvailable: () => false,
    };

    await expect(
      new ProviderChain([onlyProvider]).translate("hello", "en", "fr"),
    ).rejects.toThrow(
      "No providers ran; skipped unavailable providers: claude-code",
    );
  });

  it("prefixes plain model names with the successful provider name", async () => {
    const chain = new ProviderChain([
      fakeProvider("ollama", async () => result("local")),
    ]);

    await expect(chain.translate("hello", "en", "fr")).resolves.toMatchObject({
      model: "ollama:fake",
    });
  });

  it("disables quota-exhausted providers and falls through", async () => {
    const first = fakeProvider("claude-code", async () => {
      throw new Error("Reached maximum budget ($0.01)");
    });
    const second = fakeProvider("ollama", async () => result("local"));

    const chain = new ProviderChain([first, second]);

    expect(await chain.translate("hello", "en", "fr")).toMatchObject({
      text: "local",
    });
    expect(disabledProviders.has("claude-code")).toBe(true);
  });

  it("does not permanently disable transient provider failures", async () => {
    const first = fakeProvider("claude-code", async () => {
      throw new Error("CLI process timed out after 120000ms");
    });
    const second = fakeProvider("ollama", async () => result("local"));

    const chain = new ProviderChain([first, second]);

    await chain.translate("hello", "en", "fr");
    expect(disabledProviders.has("claude-code")).toBe(false);
  });

  it("keeps disabled providers skipped after chain reconstruction", async () => {
    let calls = 0;
    const first = fakeProvider("claude-code", async () => {
      calls++;
      throw new Error("Authentication required. Please log in.");
    });
    const second = fakeProvider("ollama", async () => result("local"));

    await new ProviderChain([first, second]).translate("hello", "en", "fr");
    await new ProviderChain([first, second]).translate("hello", "en", "fr");

    expect(calls).toBe(1);
  });

  it("throws ProviderChainError when all providers fail", async () => {
    const chain = new ProviderChain([
      fakeProvider("claude-code", async () => {
        throw new Error("Reached maximum budget ($0.01)");
      }),
      fakeProvider("ollama", async () => {
        throw new Error("fetch failed");
      }),
    ]);

    await expect(chain.translate("hello", "en", "fr")).rejects.toMatchObject({
      finalProvider: "ollama",
      finalCode: "network",
      attempts: [
        { providerName: "claude-code", code: "quota_exhausted" },
        { providerName: "ollama", code: "network" },
      ],
    });
    await expect(chain.translate("hello", "en", "fr")).rejects.toBeInstanceOf(
      ProviderChainError,
    );
  });

  it("limits concurrent calls to the same CLI provider", async () => {
    process.env.CLAUDE_CODE_CONCURRENCY = "1";
    let active = 0;
    let maxActive = 0;
    const provider = fakeProvider("claude-code", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
      return result("done");
    });

    const chain = new ProviderChain([provider]);
    await Promise.all([
      chain.translate("one", "en", "fr"),
      chain.translate("two", "en", "fr"),
    ]);

    expect(maxActive).toBe(1);
  });

  it("uses updated CLI concurrency after same-process env changes", async () => {
    process.env.CLAUDE_CODE_CONCURRENCY = "1";
    const firstProvider = fakeProvider("claude-code", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return result("first");
    });
    await new ProviderChain([firstProvider]).translate("first", "en", "fr");

    process.env.CLAUDE_CODE_CONCURRENCY = "2";
    let active = 0;
    let maxActive = 0;
    const secondProvider = fakeProvider("claude-code", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
      return result("done");
    });

    const chain = new ProviderChain([secondProvider]);
    await Promise.all([
      chain.translate("one", "en", "fr"),
      chain.translate("two", "en", "fr"),
    ]);

    expect(maxActive).toBe(2);
  });
});

function fakeProvider(
  name: string,
  translate: LLMProvider["translate"],
): LLMProvider {
  return { name, translate };
}

function result(text: string): TranslationResult {
  return { text, tokensUsed: 1, model: "fake" };
}
