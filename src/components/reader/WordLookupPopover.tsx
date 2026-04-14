"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export interface WordSelection {
  word: string;
  lang: string;
  rect: DOMRect;
  contextText: string;
}

interface LookupResult {
  dictionaryId: string;
  dictionaryName: string;
  // 'ja' | 'zh' — tells us a CEDICT hit for a Japanese-word lookup
  // carries Chinese pinyin, not Japanese reading. Used for voice + label.
  sourceLang: string;
  headword: string;
  reading: string;
  gloss: string;
}

interface WordLookupPopoverProps {
  selection: WordSelection;
  bookId: string;
  onClose: () => void;
}

type SaveState = "idle" | "saving" | "saved" | "error";

const LANG_VOICE: Record<string, string> = { ja: "ja-JP", zh: "zh-CN", en: "en-US" };

// Glosses come out of the parsers joined with a language-specific separator
// (JMdict uses "; ", CEDICT uses " / "). The dictionary blob can be long —
// cap to the first N senses before saving so vocabulary rows stay readable.
const MAX_SENSES = 5;
function truncateGloss(gloss: string, lang: string): string {
  const sep = lang === "zh" ? " / " : "; ";
  const parts = gloss.split(sep);
  if (parts.length <= MAX_SENSES) return gloss;
  return parts.slice(0, MAX_SENSES).join(sep);
}

function speak(text: string, lang: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = LANG_VOICE[lang] || lang;
  u.rate = 0.9;
  window.speechSynthesis.speak(u);
}

export function WordLookupPopover({ selection, bookId, onClose }: WordLookupPopoverProps) {
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<LookupResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<Record<number, SaveState>>({});
  const popoverRef = useRef<HTMLDivElement>(null);

  // Fetch dictionary entries
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch("/api/dict/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang: selection.lang, query: selection.word }),
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || "Lookup failed");
        return r.json();
      })
      .then((data: { results: LookupResult[] }) => {
        setResults(data.results);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setError(err.message);
        setLoading(false);
      });
    return () => controller.abort();
  }, [selection.lang, selection.word]);

  // Close on outside click or ESC
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer the mousedown listener by one tick so the selection event that
    // opened us doesn't also close us.
    const t = setTimeout(() => {
      document.addEventListener("mousedown", handleMouseDown);
    }, 0);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const handleSave = useCallback(
    async (index: number, result: LookupResult) => {
      setSaveState((s) => ({ ...s, [index]: "saving" }));
      try {
        const res = await fetch("/api/vocabulary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            word: selection.word,
            lang: selection.lang,
            reading: result.reading || null,
            gloss: truncateGloss(result.gloss, selection.lang),
            sourceBookId: bookId,
            sourceContext: selection.contextText || null,
          }),
        });
        if (!res.ok) throw new Error("Save failed");
        setSaveState((s) => ({ ...s, [index]: "saved" }));
      } catch {
        setSaveState((s) => ({ ...s, [index]: "error" }));
      }
    },
    [selection, bookId],
  );

  // Position: place popover below the selection, clamp to viewport.
  const POPOVER_WIDTH = 360;
  const left = Math.max(
    8,
    Math.min(selection.rect.left, window.innerWidth - POPOVER_WIDTH - 8),
  );
  const top = selection.rect.bottom + 8;

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 bg-popover text-popover-foreground border border-border rounded-md shadow-lg p-3 text-sm"
      style={{ top, left, width: POPOVER_WIDTH, maxHeight: "50vh", overflowY: "auto" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="font-semibold mb-2 pb-2 border-b border-border flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          {selection.word}
          <button
            onClick={() => speak(selection.word, selection.lang)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Speak"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
          </button>
        </span>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground text-xs"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {loading && <p className="text-muted-foreground">Looking up…</p>}
      {error && <p className="text-destructive">{error}</p>}
      {!loading && !error && results.length === 0 && (
        <p className="text-muted-foreground">
          No entries found. Try a shorter word, or install a dictionary on the
          {" "}
          <a href="/dictionary" className="underline">Dictionaries</a> page.
        </p>
      )}

      {results.length > 0 && (
        <ul className="space-y-3">
          {results.map((r, i) => {
            // A cross-reference hit is a row whose dictionary source_lang
            // differs from the word's own language (e.g. CEDICT row for a
            // Japanese lookup). Tag these so the reading is voiced in the
            // right language and the user knows the reading is pinyin.
            const isCrossRef = r.sourceLang && r.sourceLang !== selection.lang;
            const readingLabel =
              r.sourceLang === "zh" ? "pinyin" : r.sourceLang === "ja" ? "kana" : null;
            return (
            <li key={`${r.dictionaryId}-${i}`} className="space-y-1">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-medium">{r.headword}</span>
                {r.reading && (
                  <span className="text-xs text-muted-foreground">
                    {r.reading}
                    {isCrossRef && readingLabel && (
                      <span className="ml-1 opacity-70">({readingLabel})</span>
                    )}
                  </span>
                )}
                <button
                  onClick={() => speak(r.headword, r.sourceLang || selection.lang)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Speak word"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                </button>
                {isCrossRef && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/60 text-muted-foreground uppercase tracking-wide">
                    cross-ref
                  </span>
                )}
              </div>
              <div className="text-muted-foreground">{r.gloss}</div>
              <div className="flex items-center justify-between pt-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  {r.dictionaryName}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saveState[i] === "saving" || saveState[i] === "saved"}
                  onClick={() => handleSave(i, r)}
                >
                  {saveState[i] === "saving"
                    ? "Saving…"
                    : saveState[i] === "saved"
                      ? "Saved ✓"
                      : saveState[i] === "error"
                        ? "Retry"
                        : "+ Save"}
                </Button>
              </div>
            </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3 pt-2 border-t border-border">
        <Link
          href="/vocabulary"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          View Vocabulary →
        </Link>
      </div>
    </div>
  );
}
