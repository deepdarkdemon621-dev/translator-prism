"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { VocabularyEntry } from "@/components/vocabulary/VocabularyEditDialog";
import { stageLabel } from "@/lib/vocab/srs";

type ReviewEntry = VocabularyEntry & {
  stage: number;
  nextReviewAt: string | null;
  lastReviewedAt: string | null;
  correctCount: number;
  incorrectCount: number;
};

type Rating = "again" | "good" | "easy";

const LANG_VOICE: Record<string, string> = { ja: "ja-JP", zh: "zh-CN", en: "en-US" };

function speak(text: string, lang: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = LANG_VOICE[lang] || lang;
  u.rate = 0.9;
  window.speechSynthesis.speak(u);
}

function langLabel(lang: string): string {
  if (lang === "ja") return "日本語";
  if (lang === "zh") return "中文";
  if (lang === "en") return "English";
  return lang.toUpperCase();
}

export default function VocabularyReviewPage() {
  const [queue, setQueue] = useState<ReviewEntry[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ again: 0, good: 0, easy: 0 });

  const current = queue[index];
  const remaining = Math.max(0, queue.length - index);
  const completed = stats.again + stats.good + stats.easy;

  const loadDue = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/vocabulary?due=1&sort=due");
      if (res.ok) {
        setQueue(await res.json());
        setIndex(0);
        setRevealed(false);
        setStats({ again: 0, good: 0, easy: 0 });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDue();
  }, [loadDue]);

  const handleRate = useCallback(
    async (rating: Rating) => {
      if (!current) return;
      setStats((s) => ({ ...s, [rating]: s[rating] + 1 }));
      setRevealed(false);
      setIndex((i) => i + 1);
      // Fire-and-forget: UI advances immediately; server updates the card.
      // If it fails the next loadDue() will pick the card up again.
      fetch(`/api/vocabulary/${current.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating }),
      }).catch(() => {});
    },
    [current],
  );

  // Keyboard shortcuts: space reveals; 1/2/3 rate Again/Good/Easy.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!current) return;
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;

      if (!revealed) {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          setRevealed(true);
        }
        return;
      }
      if (e.key === "1") handleRate("again");
      else if (e.key === "2" || e.key === " " || e.key === "Enter") {
        e.preventDefault();
        handleRate("good");
      } else if (e.key === "3") handleRate("easy");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, revealed, handleRate]);

  const progressPct = useMemo(() => {
    if (queue.length === 0) return 0;
    return Math.round((completed / queue.length) * 100);
  }, [completed, queue.length]);

  return (
    <div className="min-h-screen px-6 py-10 sm:py-14 max-w-2xl mx-auto">
      <header className="mb-8 flex items-center justify-between gap-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
        <div className="flex items-center gap-4">
          <Link
            href="/vocabulary"
            className="h-10 w-10 flex items-center justify-center rounded-full border border-border/60 text-foreground hover:bg-accent/60 hover:border-primary/40 hover:-translate-x-0.5 transition-all duration-200"
            aria-label="Back to vocabulary"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
          </Link>
          <h1
            className="text-2xl sm:text-3xl font-medium tracking-tight"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            Review
          </h1>
        </div>
        {queue.length > 0 && (
          <div className="text-xs text-muted-foreground tabular-nums">
            {completed} / {queue.length}
          </div>
        )}
      </header>

      {queue.length > 0 && (
        <div className="h-1 rounded-full bg-muted/60 overflow-hidden mb-8">
          <div
            className="h-full bg-primary/70 transition-all duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      {loading ? (
        <p className="text-muted-foreground text-center py-24 italic" style={{ fontFamily: "var(--font-heading)" }}>
          Loading…
        </p>
      ) : !current ? (
        <EmptyState hasProgress={completed > 0} onReload={loadDue} stats={stats} />
      ) : (
        <ReviewCard
          entry={current}
          revealed={revealed}
          onReveal={() => setRevealed(true)}
          onRate={handleRate}
          remaining={remaining}
        />
      )}
    </div>
  );
}

function ReviewCard({
  entry,
  revealed,
  onReveal,
  onRate,
  remaining,
}: {
  entry: ReviewEntry;
  revealed: boolean;
  onReveal: () => void;
  onRate: (rating: Rating) => void;
  remaining: number;
}) {
  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="rounded-2xl border border-border/50 bg-card shadow-sm px-8 py-12 sm:px-12 sm:py-16 min-h-[340px] flex flex-col justify-center">
        <div className="flex items-center justify-between mb-8">
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">
            {langLabel(entry.lang)} · {stageLabel(entry.stage)}
          </span>
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {remaining} left
          </span>
        </div>

        <div className="text-center">
          <div className="flex items-center justify-center gap-3 mb-3">
            <h2
              className="text-5xl sm:text-6xl font-medium tracking-tight break-words"
              style={{ fontFamily: "var(--font-heading)" }}
            >
              {entry.word}
            </h2>
            <button
              onClick={(e) => {
                e.stopPropagation();
                speak(entry.word, entry.lang);
              }}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Read aloud"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
            </button>
          </div>
          {entry.reading && (
            <div className="text-lg text-muted-foreground italic mb-8">{entry.reading}</div>
          )}

          {revealed ? (
            <div className="animate-in fade-in duration-300 space-y-4 mt-6">
              <div className="text-lg text-foreground/90 leading-relaxed">{entry.gloss}</div>
              {entry.note && (
                <div className="text-sm text-muted-foreground italic">Note: {entry.note}</div>
              )}
              {entry.sourceContext && (
                <div className="text-sm text-muted-foreground/80 italic border-l-2 border-border/60 pl-4 text-left mt-4">
                  &ldquo;{entry.sourceContext}&rdquo;
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={onReveal}
              className="mt-4 text-sm text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline"
            >
              Tap to reveal · <kbd className="px-1.5 py-0.5 text-[10px] rounded bg-muted/60 border border-border/60 ml-1">Space</kbd>
            </button>
          )}
        </div>
      </div>

      {revealed && (
        <div className="grid grid-cols-3 gap-3 mt-6 animate-in fade-in slide-in-from-bottom-1 duration-300">
          <RatingButton
            label="Again"
            hint="1"
            tone="destructive"
            onClick={() => onRate("again")}
          />
          <RatingButton
            label="Good"
            hint="2 / Space"
            tone="primary"
            onClick={() => onRate("good")}
          />
          <RatingButton
            label="Easy"
            hint="3"
            tone="muted"
            onClick={() => onRate("easy")}
          />
        </div>
      )}
    </div>
  );
}

function RatingButton({
  label,
  hint,
  tone,
  onClick,
}: {
  label: string;
  hint: string;
  tone: "destructive" | "primary" | "muted";
  onClick: () => void;
}) {
  // Border tint is the only visual difference between tones — keeps the
  // palette calm while still signaling which button does what.
  const toneClass =
    tone === "destructive"
      ? "border-destructive/40 hover:border-destructive/70 hover:bg-destructive/5"
      : tone === "primary"
        ? "border-primary/40 hover:border-primary/70 hover:bg-primary/5"
        : "border-border hover:border-foreground/40 hover:bg-muted/40";
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-1 py-4 rounded-xl border-2 transition-colors ${toneClass}`}
    >
      <span className="text-base font-medium">{label}</span>
      <kbd className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-muted/40 border border-border/40">
        {hint}
      </kbd>
    </button>
  );
}

function EmptyState({
  hasProgress,
  onReload,
  stats,
}: {
  hasProgress: boolean;
  onReload: () => void;
  stats: { again: number; good: number; easy: number };
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card shadow-sm px-8 py-16 text-center animate-in fade-in duration-500">
      <p
        className="text-2xl font-medium tracking-tight mb-2"
        style={{ fontFamily: "var(--font-heading)" }}
      >
        {hasProgress ? "Session complete" : "Nothing due"}
      </p>
      <p className="text-muted-foreground text-sm mb-8">
        {hasProgress
          ? `${stats.again} again · ${stats.good} good · ${stats.easy} easy`
          : "Come back later, or add more words from the reader."}
      </p>
      <div className="flex items-center justify-center gap-3">
        <Button variant="outline" onClick={onReload}>
          Check again
        </Button>
        <Link href="/vocabulary">
          <Button variant="ghost">Back to list</Button>
        </Link>
      </div>
    </div>
  );
}
