"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  VocabularyEditDialog,
  type VocabularyEntry,
} from "@/components/vocabulary/VocabularyEditDialog";
import { stageLabel } from "@/lib/vocab/srs";

const LANG_OPTIONS = [
  { value: "all", label: "All languages" },
  { value: "ja", label: "日本語" },
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
];

const SORT_OPTIONS = [
  { value: "recent", label: "Recently added" },
  { value: "oldest", label: "Oldest first" },
  { value: "due", label: "Due for review" },
  { value: "mastery", label: "Lowest mastery" },
  { value: "alpha", label: "Alphabetical" },
];

function formatLang(lang: string): string {
  if (lang === "ja") return "JA";
  if (lang === "zh") return "ZH";
  if (lang === "en") return "EN";
  return lang.toUpperCase();
}

function isDue(entry: VocabularyEntry, now: number): boolean {
  if (!entry.nextReviewAt) return true;
  return new Date(entry.nextReviewAt).getTime() <= now;
}

/** "in 3d" / "in 2h" / "due now" — compact relative time for list rows. */
function formatRelative(iso: string | null, now: number): string {
  if (!iso) return "due now";
  const diffMs = new Date(iso).getTime() - now;
  if (diffMs <= 0) return "due now";
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

export default function VocabularyPage() {
  const [entries, setEntries] = useState<VocabularyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [langFilter, setLangFilter] = useState<string>("all");
  const [sort, setSort] = useState<string>("recent");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<VocabularyEntry | null>(null);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (sort) params.set("sort", sort);
      const res = await fetch(`/api/vocabulary?${params.toString()}`);
      if (res.ok) {
        setEntries(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }, [sort]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const now = Date.now();
  const dueCount = useMemo(
    () => entries.filter((e) => isDue(e, now)).length,
    [entries, now],
  );

  const filtered = useMemo(() => {
    let list = entries;
    if (langFilter !== "all") {
      list = list.filter((e) => e.lang === langFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (e) =>
          e.word.toLowerCase().includes(q) ||
          e.gloss.toLowerCase().includes(q) ||
          (e.reading ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [entries, langFilter, search]);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this vocabulary entry?")) return;
    const res = await fetch(`/api/vocabulary/${id}`, { method: "DELETE" });
    if (res.ok) fetchEntries();
  };

  return (
    <div className="min-h-screen px-6 py-10 sm:py-14 max-w-4xl mx-auto">
      <header className="mb-8 flex items-center gap-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
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
          Vocabulary
        </h1>
      </header>

      {/* Review CTA — prominent when there's something due, quieter when not. */}
      <div className="mb-6 animate-in fade-in slide-in-from-bottom-2 duration-500 delay-75">
        {dueCount > 0 ? (
          <Link href="/vocabulary/review" className="block group">
            <div className="rounded-2xl border border-primary/40 bg-primary/5 hover:bg-primary/10 hover:border-primary/60 transition-colors px-6 py-5 flex items-center justify-between">
              <div>
                <div
                  className="text-lg font-medium tracking-tight"
                  style={{ fontFamily: "var(--font-heading)" }}
                >
                  {dueCount} {dueCount === 1 ? "card" : "cards"} due
                </div>
                <div className="text-sm text-muted-foreground mt-0.5">
                  Start a quick review session
                </div>
              </div>
              <span className="text-primary text-xl group-hover:translate-x-0.5 transition-transform">
                →
              </span>
            </div>
          </Link>
        ) : (
          <div className="rounded-2xl border border-border/50 bg-muted/20 px-6 py-4 text-sm text-muted-foreground flex items-center justify-between">
            <span>No cards due right now — nicely done.</span>
            <Link href="/vocabulary/review" className="underline underline-offset-4 hover:text-foreground transition-colors">
              Open review
            </Link>
          </div>
        )}
      </div>

      <Card className="mb-5 border-border/50 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-500 delay-100">
        <CardHeader className="pb-3">
          <CardTitle className="text-xs uppercase tracking-[0.18em] text-muted-foreground font-medium">
            Filter
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row">
          <div className="sm:w-44">
            <Select
              value={langFilter}
              onValueChange={(v) => { if (v !== null) setLangFilter(v); }}
            >
              <SelectTrigger aria-label="Filter by language" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANG_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="sm:w-52">
            <Select
              value={sort}
              onValueChange={(v) => { if (v !== null) setSort(v); }}
            >
              <SelectTrigger aria-label="Sort order" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            placeholder="Search word, reading, or gloss…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
          />
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-500 delay-150">
        <CardHeader>
          <CardTitle
            className="text-base font-medium tracking-tight"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            {filtered.length} {filtered.length === 1 ? "entry" : "entries"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground text-center py-8 italic" style={{ fontFamily: "var(--font-heading)" }}>
              Loading…
            </p>
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground text-center py-10 italic" style={{ fontFamily: "var(--font-heading)" }}>
              {entries.length === 0
                ? "No vocabulary yet. Select a word in the reader to save it."
                : "No entries match your filter."}
            </p>
          ) : (
            <div className="divide-y divide-border/50">
              {filtered.map((e, i) => {
                const due = isDue(e, now);
                return (
                  <div
                    key={e.id}
                    className="py-4 flex items-start gap-4 stagger-fade-in"
                    style={{ animationDelay: `${i * 30}ms` }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span
                          className="text-xl font-medium tracking-tight"
                          style={{ fontFamily: "var(--font-heading)" }}
                        >
                          {e.word}
                        </span>
                        {e.reading && (
                          <span className="text-sm text-muted-foreground italic">{e.reading}</span>
                        )}
                        <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground bg-muted/60 rounded-full px-2 py-0.5 font-medium">
                          {formatLang(e.lang)}
                        </span>
                        <span
                          className={`text-[10px] uppercase tracking-[0.12em] rounded-full px-2 py-0.5 font-medium ${
                            due
                              ? "bg-primary/15 text-primary"
                              : "bg-muted/40 text-muted-foreground"
                          }`}
                          title={
                            e.nextReviewAt
                              ? `Next review: ${new Date(e.nextReviewAt).toLocaleString()}`
                              : "Never reviewed"
                          }
                        >
                          {stageLabel(e.stage)} · {formatRelative(e.nextReviewAt, now)}
                        </span>
                      </div>
                      <div className="text-sm text-foreground/80 mt-1.5 break-words leading-relaxed">
                        {e.gloss}
                      </div>
                      {e.note && (
                        <div className="text-xs text-muted-foreground mt-1.5 italic">
                          Note: {e.note}
                        </div>
                      )}
                      {e.sourceContext && (
                        <div className="text-xs text-muted-foreground/70 mt-1.5 line-clamp-2 italic">
                          &ldquo;{e.sourceContext}&rdquo;
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0 opacity-60 hover:opacity-100 transition-opacity">
                      <Button size="sm" variant="outline" onClick={() => setEditing(e)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-muted-foreground hover:text-destructive hover:border-destructive/40"
                        onClick={() => handleDelete(e.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <VocabularyEditDialog
        entry={editing}
        onClose={() => setEditing(null)}
        onSaved={fetchEntries}
      />
    </div>
  );
}
