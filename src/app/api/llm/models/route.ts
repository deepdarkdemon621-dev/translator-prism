import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { loadLLMSettings } from "@/lib/llm/settings";

/**
 * Live model list for the selected provider. Frontend calls this from
 * /settings so the Model dropdown reflects what the user's key can
 * actually access (e.g. o1, gpt-4.1) instead of a hardcoded snapshot.
 *
 * Admin-only: the request uses the stored API key, and probing paid
 * providers is a foot-gun for regular users even if it's cheap.
 *
 * The caller can optionally pass ?provider= to preview a different
 * provider's list before saving; in that case we still need the stored
 * key to match (we don't accept a raw key in the querystring — keys
 * only live in the DB or env).
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const stored = await loadLLMSettings();
  const provider = req.nextUrl.searchParams.get("provider") || stored.provider;

  try {
    if (provider === "ollama") {
      // Probes the worker host's Ollama. The browser can't reach
      // localhost:11434 in production, so we route through the server.
      const res = await fetch("http://localhost:11434/api/tags");
      if (!res.ok) {
        return NextResponse.json({
          provider,
          models: [],
          error: "Ollama not reachable on worker host",
        });
      }
      const data = (await res.json()) as { models?: { name: string }[] };
      return NextResponse.json({
        provider,
        models: (data.models ?? []).map((m) => m.name),
      });
    }

    if (provider === "openai") {
      if (!stored.apiKey) {
        return NextResponse.json({
          provider,
          models: [],
          error: "Save an API key first, then reopen this dropdown.",
        });
      }
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${stored.apiKey}` },
      });
      if (!res.ok) {
        return NextResponse.json({
          provider,
          models: [],
          error: res.status === 401 ? "API key invalid" : `HTTP ${res.status}`,
        });
      }
      const data = (await res.json()) as { data?: { id: string }[] };
      // Filter to chat-capable models. OpenAI's /v1/models returns
      // everything including embeddings, whisper, tts, moderation, etc.
      // gpt-*, o\d-*, chatgpt-* covers all current and near-future chat
      // families; embeddings/audio start with other prefixes.
      const chat = (data.data ?? [])
        .map((m) => m.id)
        .filter((id) => /^(gpt-|o\d|chatgpt-)/i.test(id))
        .sort();
      return NextResponse.json({ provider, models: chat });
    }

    if (provider === "openrouter") {
      // OpenRouter's catalog endpoint is public; attaching the key
      // doesn't change the list but lets us use the same 401-handling
      // branch for consistency.
      const headers: Record<string, string> = {};
      if (stored.apiKey) headers.Authorization = `Bearer ${stored.apiKey}`;
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers,
      });
      if (!res.ok) {
        return NextResponse.json({
          provider,
          models: [],
          error: `HTTP ${res.status}`,
        });
      }
      const data = (await res.json()) as { data?: { id: string }[] };
      const models = (data.data ?? []).map((m) => m.id).sort();
      return NextResponse.json({ provider, models });
    }

    if (provider === "claude") {
      // Anthropic's model-list endpoint was added in late 2024; if it's
      // not available for the user's account we fall back to a small
      // curated list rather than empty. Keeps the dropdown useful.
      if (!stored.apiKey) {
        return NextResponse.json({
          provider,
          models: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"],
          error: "Save an API key to refresh.",
        });
      }
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": stored.apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      if (!res.ok) {
        return NextResponse.json({
          provider,
          models: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"],
          error: res.status === 401 ? "API key invalid" : `HTTP ${res.status}`,
        });
      }
      const data = (await res.json()) as { data?: { id: string }[] };
      const models = (data.data ?? []).map((m) => m.id).sort();
      return NextResponse.json({ provider, models });
    }

    return NextResponse.json({
      provider,
      models: [],
      error: `Unknown provider: ${provider}`,
    });
  } catch (err) {
    return NextResponse.json({
      provider,
      models: [],
      error: err instanceof Error ? err.message : "Network error",
    });
  }
}
