"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface LearningStats {
  windowDays: number;
  streak: number;
  totalWords: number;
  dueNow: number;
  knownWords: number;
  retention: number | null;
  reviewsByDay: { day: string; total: number; correct: number }[];
  readingByDay: { day: string; durationMs: number; charsRead: number }[];
  vocabAddedByDay: { day: string; added: number }[];
}

const CHART_DAYS = 14;

function lastDays(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    out.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    );
  }
  return out;
}

export default function LearnPage() {
  const [stats, setStats] = useState<LearningStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/learning/stats")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: LearningStats) => {
        if (!cancelled) setStats(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const days = lastDays(CHART_DAYS);
  const reviewMap = new Map(stats?.reviewsByDay.map((r) => [r.day, r]) ?? []);
  const readingMap = new Map(stats?.readingByDay.map((r) => [r.day, r]) ?? []);
  const addedMap = new Map(stats?.vocabAddedByDay.map((r) => [r.day, r.added]) ?? []);

  return (
    <div className="min-h-screen px-6 py-10 sm:py-14 max-w-4xl mx-auto">
      <header className="mb-10 flex items-center justify-between gap-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
        <div>
          <h1
            className="text-3xl sm:text-4xl font-medium tracking-tight"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            Learning
          </h1>
          <p className="text-muted-foreground text-sm mt-1 italic" style={{ fontFamily: "var(--font-heading)" }}>
            Reading feeds words; reviews keep them.
          </p>
        </div>
        <nav className="flex items-center gap-2 text-sm">
          <Link href="/vocabulary">
            <Button variant="outline" size="sm">Vocabulary</Button>
          </Link>
          {stats && stats.dueNow > 0 && (
            <Link href="/vocabulary/review">
              <Button size="sm">Review {stats.dueNow} due</Button>
            </Link>
          )}
        </nav>
      </header>

      {error && <p className="text-destructive text-sm">Failed to load: {error}</p>}
      {!stats && !error && (
        <p className="text-muted-foreground italic" style={{ fontFamily: "var(--font-heading)" }}>
          Loading…
        </p>
      )}

      {stats && (
        <div className="space-y-8 animate-in fade-in duration-500">
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="Streak" value={`${stats.streak}d`} />
            <StatCard label="Due now" value={String(stats.dueNow)} />
            <StatCard label="Words saved" value={String(stats.totalWords)} />
            <StatCard label="Marked known" value={String(stats.knownWords)} />
          </section>

          {stats.retention != null && (
            <p className="text-xs text-muted-foreground">
              Retention over the last {stats.windowDays} days:{" "}
              <span className="text-foreground font-medium tabular-nums">
                {Math.round(stats.retention * 100)}%
              </span>{" "}
              of reviews rated Hard or better.
            </p>
          )}

          <ChartCard
            title="Reviews"
            days={days}
            values={days.map((d) => reviewMap.get(d)?.total ?? 0)}
            format={(v) => `${v} reviews`}
          />
          <ChartCard
            title="Reading time"
            days={days}
            values={days.map((d) => Math.round((readingMap.get(d)?.durationMs ?? 0) / 60_000))}
            format={(v) => `${v} min`}
          />
          <ChartCard
            title="Words added"
            days={days}
            values={days.map((d) => addedMap.get(d) ?? 0)}
            format={(v) => `${v} words`}
          />
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="border-border/50 shadow-sm">
      <CardContent className="pt-5 pb-4 text-center">
        <div
          className="text-2xl font-medium tabular-nums"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          {value}
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mt-1">
          {label}
        </div>
      </CardContent>
    </Card>
  );
}

function ChartCard({
  title,
  days,
  values,
  format,
}: {
  title: string;
  days: string[];
  values: number[];
  format: (v: number) => string;
}) {
  const max = Math.max(1, ...values);
  return (
    <Card className="border-border/50 shadow-sm">
      <CardContent className="pt-5 pb-4">
        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground mb-3">
          {title}
        </div>
        <div className="flex items-end gap-1.5 h-24">
          {values.map((v, i) => (
            <div
              key={days[i]}
              className="flex-1 rounded-t bg-primary/60 hover:bg-primary transition-colors min-h-[2px]"
              style={{ height: `${Math.max(2, (v / max) * 100)}%` }}
              title={`${days[i]}: ${format(v)}`}
            />
          ))}
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground mt-1.5 tabular-nums">
          <span>{days[0].slice(5)}</span>
          <span>{days[days.length - 1].slice(5)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
