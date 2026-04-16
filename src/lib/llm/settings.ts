import { getDb } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export interface LLMSettings {
  provider: string;
  apiKey: string;
  concurrency: number;
  baseURL?: string;
  model?: string;
  /** Set when the caller wanted a paid provider but had no key, so we
   *  silently dropped them onto local Ollama. Worker logs this once per
   *  startup; UI can surface it too. */
  fallbackReason?: string;
}

const APP_SETTINGS_KEY = "global";

interface StoredSettings {
  llm?: {
    provider?: string;
    apiKey?: string;
    concurrency?: number;
    model?: string;
  };
  reading?: Record<string, unknown>;
}

const PAID_PROVIDERS = new Set(["claude", "openai", "openrouter"]);

/**
 * Load LLM configuration. Priority:
 * 1. DB `app_settings` row — what the user chose in /settings.
 *    API key can be sourced from DB (user typed it) or env (pre-configured
 *    ANTHROPIC_API_KEY / LLM_API_KEY).
 *    Paid provider with no key anywhere → silent fallback to Ollama so the
 *    worker keeps making progress instead of failing every row.
 * 2. Env vars — bootstrap path when the DB is empty (first-run, tests).
 * 3. Ollama default.
 *
 * Previous versions put env first; that made UI changes ineffective on the
 * worker machine (where .env.worker hard-codes LLM_PROVIDER). Flipping it
 * means /settings is the source of truth, and env becomes a fallback.
 */
export async function loadLLMSettings(): Promise<LLMSettings> {
  const stored = await loadStoredSettings();
  const dbProvider = stored.llm?.provider;

  if (dbProvider) {
    const concurrency = stored.llm?.concurrency ?? 2;
    const model = stored.llm?.model;

    // Resolve API key. DB wins; env covers the common case where the admin
    // set ANTHROPIC_API_KEY on Vercel and picked "claude" in the UI without
    // re-entering the key there.
    let apiKey = stored.llm?.apiKey ?? "";
    if (!apiKey) {
      if (dbProvider === "claude" && process.env.ANTHROPIC_API_KEY) {
        apiKey = process.env.ANTHROPIC_API_KEY;
      } else if (process.env.LLM_API_KEY) {
        apiKey = process.env.LLM_API_KEY;
      }
    }

    // Graceful fallback: user picked a paid provider but no key is
    // configured anywhere. Rather than failing every translation with
    // "401 invalid api key", use local Ollama until they configure a key.
    if (PAID_PROVIDERS.has(dbProvider) && !apiKey) {
      return {
        provider: "ollama",
        apiKey: "",
        concurrency,
        model,
        fallbackReason: `${dbProvider}: no API key configured, using local Ollama`,
      };
    }

    return { provider: dbProvider, apiKey, concurrency, model };
  }

  // DB has no LLM row yet — bootstrap from env. This covers the worker's
  // first boot against a fresh Turso DB and local-dev before the admin
  // opens /settings.
  if (process.env.LLM_PROVIDER) {
    return {
      provider: process.env.LLM_PROVIDER,
      apiKey: process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
      baseURL: process.env.LLM_PROVIDER_BASE_URL,
      model: process.env.LLM_MODEL,
    };
  }

  return { provider: "ollama", apiKey: "", concurrency: 2 };
}

export async function getActiveProviderName(): Promise<string> {
  const s = await loadLLMSettings();
  return s.provider;
}

export async function isLocalProvider(): Promise<boolean> {
  return (await getActiveProviderName()) === "ollama";
}

/**
 * Read the raw settings blob (both llm + reading). Exposed for the
 * /api/settings GET handler — other code paths should prefer the typed
 * helpers above. Empty object when no row yet.
 */
export async function loadStoredSettings(): Promise<StoredSettings> {
  try {
    const db = getDb();
    const row = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, APP_SETTINGS_KEY))
      .get();
    if (!row) return {};
    return JSON.parse(row.value) as StoredSettings;
  } catch (err) {
    console.warn("[llm-settings] could not load app_settings:", err);
    return {};
  }
}

export async function saveStoredSettings(next: StoredSettings): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const payload = JSON.stringify(next);
  // INSERT ... ON CONFLICT DO UPDATE — single-row upsert keyed by 'global'.
  await db
    .insert(appSettings)
    .values({ key: APP_SETTINGS_KEY, value: payload, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: payload, updatedAt: now },
    });
}
