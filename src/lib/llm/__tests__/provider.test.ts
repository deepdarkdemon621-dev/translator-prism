import { describe, it, expect, vi } from "vitest";
import { ClaudeProvider } from "../claude";
import { OpenAIProvider } from "../openai";
import { createProvider } from "../factory";
import type { LLMProvider, TranslationResult } from "../types";

describe("LLM provider", () => {
  it("ClaudeProvider implements LLMProvider interface", () => {
    const provider = new ClaudeProvider("fake-key");
    expect(provider.name).toBe("claude");
    expect(typeof provider.translate).toBe("function");
  });

  it("createProvider returns ClaudeProvider for 'claude'", () => {
    const provider = createProvider("claude", "fake-key");
    expect(provider.name).toBe("claude");
  });

  it("createProvider throws for unknown provider", () => {
    expect(() => createProvider("unknown", "fake-key")).toThrow("Unknown provider: unknown");
  });

  it("OpenAIProvider implements LLMProvider interface", () => {
    const provider = new OpenAIProvider("fake-key");
    expect(provider.name).toBe("openai");
    expect(typeof provider.translate).toBe("function");
  });

  it("createProvider returns OpenAIProvider for 'openai'", () => {
    const provider = createProvider("openai", "fake-key");
    expect(provider.name).toBe("openai");
  });

  it("createProvider returns OpenAIProvider with name 'openrouter' for 'openrouter'", () => {
    const provider = createProvider("openrouter", "fake-key");
    expect(provider.name).toBe("openrouter");
  });
});
