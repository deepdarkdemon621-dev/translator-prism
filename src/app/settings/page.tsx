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

const MODELS: Record<string, string[]> = {
  claude: [
    "claude-sonnet-4-20250514",
    "claude-haiku-4-5-20251001",
  ],
  openai: [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
  ],
  openrouter: [
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "anthropic/claude-sonnet-4-20250514",
    "google/gemini-pro-1.5",
    "deepseek/deepseek-chat",
    "meta-llama/llama-3.3-70b-instruct",
  ],
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
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  // Theme lives in localStorage via useReaderPrefs — shared with the reader's
  // own settings drawer, so flipping it here immediately updates the <html>
  // class and any mounted reader view.
  const { prefs, update: updatePrefs } = useReaderPrefs();

  const fetchOllamaModels = useCallback(async () => {
    setOllamaError(null);
    try {
      const res = await fetch("http://localhost:11434/api/tags");
      if (!res.ok) throw new Error("Ollama not reachable");
      const data = await res.json();
      const names: string[] = (data.models ?? []).map((m: { name: string }) => m.name);
      setOllamaModels(names);
      return names;
    } catch {
      setOllamaError("无法连接 Ollama (localhost:11434)，请确认已启动");
      setOllamaModels([]);
      return [];
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
          if (data.llm.provider === "ollama") fetchOllamaModels();
        }
      })
      .catch((err) => {
        if (err.name !== "AbortError") console.error("Failed to load settings", err);
      });
    return () => controller.abort();
  }, [fetchOllamaModels]);

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
                  if (v === "ollama") {
                    fetchOllamaModels().then((models) => {
                      setLlm({ ...llm, provider: v, model: models[0] ?? "" });
                    });
                  } else {
                    const firstModel = MODELS[v]?.[0] ?? "";
                    setLlm({ ...llm, provider: v, model: firstModel });
                  }
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
            <Label id="label-llm-model" className="mb-2 block">Model</Label>
            <Select
              value={llm.model}
              onValueChange={(v) => { if (v !== null) setLlm({ ...llm, model: v }); }}
            >
              <SelectTrigger aria-labelledby="label-llm-model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(llm.provider === "ollama" ? ollamaModels : MODELS[llm.provider] || []).map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {llm.provider === "ollama" && ollamaError && (
            <p className="text-sm text-destructive">{ollamaError}</p>
          )}

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
