import type { LLMProvider } from "./types";
import { ClaudeProvider } from "./claude";
import { OpenAIProvider } from "./openai";

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
