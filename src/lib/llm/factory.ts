import type { LLMProvider } from "./types";
import { ClaudeProvider } from "./claude";
import { ClaudeCodeCliProvider, CodexCliProvider } from "./cli-providers";
import { OpenAIProvider } from "./openai";
import { ProviderChain } from "./provider-chain";

export function createProvider(name: string, apiKey: string): LLMProvider {
  switch (name) {
    case "claude":
      return new ClaudeProvider(apiKey);
    case "openai":
      return new OpenAIProvider(apiKey, {
        name: "openai",
        defaultModel: "gpt-4o-mini",
      });
    case "openrouter":
      return new OpenAIProvider(apiKey, {
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        defaultModel: "openai/gpt-4o-mini",
      });
    case "ollama":
      return new OpenAIProvider(apiKey || "ollama", {
        name: "ollama",
        baseURL: "http://localhost:11434/v1",
        defaultModel: "qwen2.5:7b",
      });
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

export function buildProviderFromEnv(
  fallbackProvider: string,
  fallbackApiKey: string,
): LLMProvider {
  const chainConfig = process.env.TRANSLATION_PROVIDER_CHAIN;
  if (!chainConfig) return createProvider(fallbackProvider, fallbackApiKey);

  const providers = chainConfig
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => createChainProvider(name, fallbackApiKey));

  if (providers.length === 0) {
    throw new Error("TRANSLATION_PROVIDER_CHAIN is empty");
  }

  return new ProviderChain(providers);
}

function createChainProvider(name: string, fallbackApiKey: string): LLMProvider {
  switch (name) {
    case "claude-code":
      if (process.env.CLAUDE_CODE_ENABLED !== "true") {
        throw new Error("CLAUDE_CODE_ENABLED=true is required for claude-code");
      }
      return new ClaudeCodeCliProvider();
    case "codex":
      if (process.env.CODEX_CLI_ENABLED !== "true") {
        throw new Error("CODEX_CLI_ENABLED=true is required for codex");
      }
      return new CodexCliProvider();
    case "claude":
    case "openai":
    case "openrouter":
    case "ollama":
      return createProvider(name, fallbackApiKey);
    default:
      throw new Error(`Unknown provider in TRANSLATION_PROVIDER_CHAIN: ${name}`);
  }
}
