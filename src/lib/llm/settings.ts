import { getDb } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export interface LLMSettings {
  provider: string;
  apiKey: string;
  concurrency: number;
  baseURL?: string;
  model?: string;
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

/**
 * Load LLM configuration. Priority order:
 * 1. LLM_PROVIDER / LLM_PROVIDER_BASE_URL / LLM_MODEL env vars (worker side)
 * 2. app_settings row in the DB (UI-driven; shared across replicas)
 * 3. Defaults
 *
 * For Claude, ANTHROPIC_API_KEY env takes precedence over DB.
 *
 * Historically backed by data/settings.json, but Vercel's read-only FS
 * silently dropped UI writes — moved to Turso so the admin's provider
 * choice actually persists.
 */
export async function loadLLMSettings(): Promise<LLMSettings> {
  if (process.env.LLM_PROVIDER) {
    return {
      provider: process.env.LLM_PROVIDER,
      apiKey: process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
      baseURL: process.env.LLM_PROVIDER_BASE_URL,
      model: process.env.LLM_MODEL,
    };
  }
  const stored = await loadStoredSettings();
  const provider = stored.llm?.provider ?? "claude";
  const apiKey =
    provider === "claude" && process.env.ANTHROPIC_API_KEY
      ? process.env.ANTHROPIC_API_KEY
      : stored.llm?.apiKey ?? "";
  return {
    provider,
    apiKey,
    concurrency: stored.llm?.concurrency ?? 2,
    model: stored.llm?.model,
  };
}

export async function getActiveProviderName(): Promise<string> {
  if (process.env.LLM_PROVIDER) return process.env.LLM_PROVIDER;
  const stored = await loadStoredSettings();
  return stored.llm?.provider ?? "claude";
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
