"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import Link from "next/link";
import { useReaderPrefs, type ReaderPrefs } from "@/lib/reader/prefs";

interface LLMSettings {
  provider: string;
  model: string;
  apiKey: string;
  concurrency: number;
}

// Fallback model hints used only when the live /api/llm/models fetch
// fails (no API key saved yet, or 401). Once the user saves a key and
// re-opens the dropdown, we fetch the real list from the provider.
const FALLBACK_MODELS: Record<string, string[]> = {
  claude: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"],
  openai: ["gpt-4o", "gpt-4o-mini"],
  openrouter: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4-20250514"],
  ollama: [],
};

const PROVIDER_LABELS: Record<string, string> = {
  ollama: "Ollama (本地模型)",
  claude: "Claude (Anthropic)",
  openai: "OpenAI",
  openrouter: "OpenRouter (多模型聚合)",
};

const LOCAL_PROVIDERS = new Set(["ollama"]);

export default function SettingsPage() {
  const [llm, setLlm] = useState<LLMSettings>({
    provider: "claude",
    model: "claude-sonnet-4-20250514",
    apiKey: "",
    concurrency: 2,
  });
  const [saved, setSaved] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  // Dynamically fetched model list for the current provider — OpenAI,
  // OpenRouter and Claude have /v1/models; Ollama uses /api/tags on the
  // worker host. When empty, the UI falls back to FALLBACK_MODELS below.
  const [liveModels, setLiveModels] = useState<string[]>([]);
  const [modelFetchError, setModelFetchError] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  // Theme lives in localStorage via useReaderPrefs — shared with the reader's
  // own settings drawer, so flipping it here immediately updates the <html>
  // class and any mounted reader view.
  const { prefs, update: updatePrefs } = useReaderPrefs();

  // Fetch the model catalog for a given provider via our server proxy.
  // The server uses the stored API key (or ollama/openrouter's public
  // endpoint) so the browser never touches raw keys. Returns the list
  // so callers can pick a sensible default when switching providers.
  const fetchModelsFor = useCallback(async (providerName: string) => {
    setModelFetchError(null);
    setModelsLoading(true);
    try {
      const res = await fetch(
        `/api/llm/models?provider=${encodeURIComponent(providerName)}`,
      );
      if (!res.ok) {
        setModelFetchError(`HTTP ${res.status}`);
        setLiveModels([]);
        return [];
      }
      const data: { models: string[]; error?: string } = await res.json();
      if (data.error) setModelFetchError(data.error);
      setLiveModels(data.models);
      return data.models;
    } catch (err) {
      setModelFetchError(err instanceof Error ? err.message : "Network error");
      setLiveModels([]);
      return [];
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal })
      .then((r) => {
        // Non-admin users get 403 — that's expected. Only the admin-only
        // LLM card cares; the theme card below works off localStorage.
        if (r.status === 403) {
          setIsAdmin(false);
          return null;
        }
        setIsAdmin(true);
        return r.json();
      })
      .then((data) => {
        if (data?.llm) {
          setLlm(data.llm);
          // Fetch the live model list for whatever provider the DB has.
          // If it fails (no key yet, network hiccup), the render path
          // falls back to FALLBACK_MODELS so the dropdown isn't empty.
          fetchModelsFor(data.llm.provider);
        }
      })
      .catch((err) => {
        if (err.name !== "AbortError") console.error("Failed to load settings", err);
      });
    return () => controller.abort();
  }, [fetchModelsFor]);

  const handleSave = async () => {
    const { apiKey: _ignored, ...llmWithoutKey } = llm;
    const payload = {
      llm: apiKeyInput ? { ...llmWithoutKey, apiKey: apiKeyInput } : llmWithoutKey,
    };
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSaved(true);
        setSaveError(null);
        setApiKeyInput("");
        setTimeout(() => setSaved(false), 2000);
        // Freshly-saved key likely unlocks a bigger model catalogue.
        // Refetch so the Model dropdown picks up newly accessible models.
        fetchModelsFor(llm.provider);
      } else {
        setSaveError("Save failed. Please try again.");
      }
    } catch (err) {
      console.error("Failed to save settings", err);
      setSaveError("Network error. Please try again.");
    }
  };

  return (
    <div className="min-h-screen px-6 py-10 sm:py-14 max-w-2xl mx-auto">
      <header className="mb-10 flex items-center gap-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
        <Link
          href="/"
          className="h-10 w-10 flex items-center justify-center rounded-full border border-border/60 text-foreground hover:bg-accent/60 hover:border-primary/40 hover:-translate-x-0.5 transition-all duration-200"
          aria-label="Back to library"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        </Link>
        <h1
          className="text-3xl font-medium tracking-tight"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Settings
        </h1>
      </header>

      <Card className="mb-6 border-border/50 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-500 delay-75">
        <CardHeader>
          <CardTitle
            className="text-base font-medium tracking-tight"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            Appearance
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label id="label-theme" className="mb-2 block">Theme</Label>
            <Select
              value={prefs.theme}
              onValueChange={(v) => {
                if (v !== null) updatePrefs({ theme: v as ReaderPrefs["theme"] });
              }}
            >
              <SelectTrigger aria-labelledby="label-theme" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="sepia">Sepia</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Shared with the reader — changes apply everywhere immediately.
            </p>
          </div>
        </CardContent>
      </Card>

      {isAdmin && (
      <Card className="border-border/50 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-500 delay-100">
        <CardHeader>
          <CardTitle
            className="text-base font-medium tracking-tight"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            LLM Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label id="label-llm-provider" className="mb-2 block">Provider</Label>
            <Select
              value={llm.provider}
              // Base UI Select can emit null on deselect — guard against corrupting state
              onValueChange={(v) => {
                if (v !== null) {
                  fetchModelsFor(v).then((models) => {
                    // Prefer live list; fall back to our static hints when
                    // the live fetch came back empty (no key, etc.).
                    const source = models.length > 0 ? models : FALLBACK_MODELS[v] ?? [];
                    setLlm({ ...llm, provider: v, model: source[0] ?? "" });
                  });
                }
              }}
            >
              <SelectTrigger aria-labelledby="label-llm-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label id="label-llm-model">Model</Label>
              <button
                type="button"
                onClick={() => fetchModelsFor(llm.provider)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                disabled={modelsLoading}
              >
                {modelsLoading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            <Select
              value={llm.model}
              onValueChange={(v) => { if (v !== null) setLlm({ ...llm, model: v }); }}
            >
              <SelectTrigger aria-labelledby="label-llm-model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(liveModels.length > 0
                  ? liveModels
                  : FALLBACK_MODELS[llm.provider] || []
                ).map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {modelFetchError && (
              <p className="text-xs text-muted-foreground mt-1">
                {modelFetchError}
                {liveModels.length === 0 && (FALLBACK_MODELS[llm.provider]?.length ?? 0) > 0 &&
                  " (showing fallback list)"}
              </p>
            )}
          </div>

          {!LOCAL_PROVIDERS.has(llm.provider) && (
            <div>
              <Label htmlFor="llm-api-key" className="mb-2 block">API Key</Label>
              <Input
                id="llm-api-key"
                type="password"
                placeholder={llm.apiKey ? "***configured*** (enter new to update)" : "sk-ant-..."}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
              />
            </div>
          )}

          <div>
            <Label id="label-llm-concurrency" className="mb-2 block">Concurrency: {llm.concurrency}</Label>
            <Slider
              aria-label="Concurrency"
              value={[llm.concurrency]}
              min={1}
              max={5}
              step={1}
              onValueChange={(v) => {
                const val = Array.isArray(v) ? v[0] : v;
                if (val !== undefined) setLlm({ ...llm, concurrency: val });
              }}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {LOCAL_PROVIDERS.has(llm.provider)
                ? "本地模型建议设为 1，避免内存不足"
                : "Number of simultaneous translation requests"}
            </p>
          </div>

          <Button onClick={handleSave}>{saved ? "Saved!" : "Save Settings"}</Button>
          {saveError && <p className="text-sm text-destructive mt-2">{saveError}</p>}
        </CardContent>
      </Card>
      )}
    </div>
  );
}
