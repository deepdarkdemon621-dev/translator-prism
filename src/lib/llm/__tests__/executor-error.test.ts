import { describe, expect, it } from "vitest";
import { classifyTranslationFailure, getResultProviderName } from "../executor";
import { ProviderChainError } from "../provider-chain";

describe("executor translation failure classification", () => {
  it("preserves ProviderChainError finalCode instead of reclassifying the wrapper message", () => {
    const err = new ProviderChainError(
      [
        {
          providerName: "claude-code",
          code: "quota_exhausted",
          message: "Reached maximum budget ($0.01)",
        },
      ],
      "claude-code",
      "quota_exhausted",
    );

    expect(classifyTranslationFailure(err).code).toBe("quota_exhausted");
  });

  it("uses model prefixes for chain providers and provider name for plain models", () => {
    expect(getResultProviderName("claude-code:sonnet", "provider-chain")).toBe(
      "claude-code",
    );
    expect(getResultProviderName("gpt-4o-mini", "openai")).toBe("openai");
  });
});
