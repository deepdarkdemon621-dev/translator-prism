import fs from "fs";
import path from "path";

export interface LLMSettings {
  provider: string;
  apiKey: string;
  concurrency: number;
  baseURL?: string;
  model?: string;
}

const SETTINGS_PATH = path.join(process.cwd(), "data", "settings.json");

/**
 * Load LLM configuration. Priority order:
 * 1. LLM_PROVIDER / LLM_PROVIDER_BASE_URL / LLM_MODEL env vars (worker side)
 * 2. data/settings.json (local-dev fallback)
 * 3. Defaults
 *
 * For Claude, ANTHROPIC_API_KEY env takes precedence over settings.json.
 */
export function loadLLMSettings(): LLMSettings {
  if (process.env.LLM_PROVIDER) {
    return {
      provider: process.env.LLM_PROVIDER,
      apiKey: process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
      baseURL: process.env.LLM_PROVIDER_BASE_URL,
      model: process.env.LLM_MODEL,
    };
  }
  try {
    const data = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(data);
    const provider = parsed.llm?.provider ?? "claude";
    // Empty-string fallback is intentional: `createProvider` requires
    // `string`, and the provider layer treats `""` as "use env / SDK default".
    const apiKey =
      provider === "claude" && process.env.ANTHROPIC_API_KEY
        ? process.env.ANTHROPIC_API_KEY
        : parsed.llm?.apiKey ?? "";
    return {
      provider,
      apiKey,
      concurrency: parsed.llm?.concurrency ?? 2,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[llm-settings] could not load settings.json:", err);
    }
    return { provider: "claude", apiKey: "", concurrency: 2 };
  }
}

export function getActiveProviderName(): string {
  return loadLLMSettings().provider;
}

export function isLocalProvider(): boolean {
  return getActiveProviderName() === "ollama";
}
