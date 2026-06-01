import { beforeEach, describe, it, expect } from "vitest";
import { ClaudeProvider } from "../claude";
import { OpenAIProvider } from "../openai";
import { buildProviderFromEnv, createProvider } from "../factory";

describe("LLM provider", () => {
  beforeEach(() => {
    delete process.env.TRANSLATION_PROVIDER_CHAIN;
    delete process.env.CLAUDE_CODE_ENABLED;
    delete process.env.CODEX_CLI_ENABLED;
  });

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

  it("buildProviderFromEnv keeps existing provider behavior when chain is not configured", () => {
    const provider = buildProviderFromEnv("ollama", "");

    expect(provider.name).toBe("ollama");
  });

  it("buildProviderFromEnv creates a provider chain from TRANSLATION_PROVIDER_CHAIN", () => {
    process.env.TRANSLATION_PROVIDER_CHAIN = "ollama";

    const provider = buildProviderFromEnv("ollama", "");

    expect(provider.name).toBe("provider-chain");
  });

  it("requires Claude Code to be explicitly enabled in chain mode", () => {
    process.env.TRANSLATION_PROVIDER_CHAIN = "claude-code,ollama";

    expect(() => buildProviderFromEnv("ollama", "")).toThrow(
      "CLAUDE_CODE_ENABLED=true",
    );
  });

  it("requires Codex CLI to be explicitly enabled in chain mode", () => {
    process.env.TRANSLATION_PROVIDER_CHAIN = "codex,ollama";

    expect(() => buildProviderFromEnv("ollama", "")).toThrow(
      "CODEX_CLI_ENABLED=true",
    );
  });
});
