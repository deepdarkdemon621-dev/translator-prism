"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  filterProgressBooks,
  getAdjacentProgressPage,
  getDefaultProgressFilter,
  paginateProgressBooks,
  type ProgressBookSummary,
  type ProgressFilter,
} from "@/lib/progress-view";

type BookProgress = ProgressBookSummary;

type LLMErrorCode =
  | "quota_exhausted"
  | "rate_limit"
  | "auth_error"
  | "model_not_found"
  | "network"
  | "unknown";

interface ProgressResponse {
  overall: {
    done: number;
    pending: number;
    processing: number;
    failed: number;
    total: number;
  };
  books: BookProgress[];
  throughput: {
    recentDone: number;
    windowSeconds: number;
    etaSeconds: number | null;
  };
  recentFailure: {
    code: LLMErrorCode;
    message: string;
    at: string;
  } | null;
  activeProvider: string;
}

function formatEta(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hrs} hr` : `${hrs}h ${rem}m`;
}

function pct(done: number, total: number): number {
  if (total === 0) return 0;
  return (done / total) * 100;
}

const BOOKS_PAGE_SIZE = 10;

export default function ProgressPage() {
  const [data, setData] = useState<ProgressResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [bookFilter, setBookFilter] = useState<ProgressFilter>("active");
  const [bookPage, setBookPage] = useState(1);
  // Live-region toggle so screen readers re-announce the refresh even
  // when the numbers haven't changed. Not visible to sighted users.
  const tickRef = useRef(0);

  const fetchProgress = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/translation-progress", {
        cache: "no-store",
      });
      if (!res.ok) {
        setError(`Failed to load (${res.status})`);
        return;
      }
      const json: ProgressResponse = await res.json();
      setData(json);
      setBookFilter((current) =>
        current === "active" ? getDefaultProgressFilter(json.books) : current,
      );
      setError(null);
      setLastUpdated(new Date());
      tickRef.current += 1;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Load once on mount. Auto-refresh was removed to stay under the Turso
  // monthly row-read quota — a 5s poll on this page alone was burning
  // ~2M reads/month. Users hit the Refresh button when they want a
  // fresh snapshot.
  useEffect(() => {
    fetchProgress();
  }, [fetchProgress]);

  const handleRetryFailed = useCallback(async () => {
    setRetrying(true);
    setRetryMessage(null);
    try {
      const res = await fetch("/api/translations/retry-failed", {
        method: "POST",
      });
      if (!res.ok) {
        setRetryMessage(`Retry failed (${res.status})`);
        return;
      }
      const json: { reset: number } = await res.json();
      setRetryMessage(
        json.reset === 0
          ? "Nothing to retry."
          : `Reset ${json.reset} failed translations to pending.`,
      );
      fetchProgress();
    } catch (err) {
      setRetryMessage(err instanceof Error ? err.message : "Network error");
    } finally {
      setRetrying(false);
    }
  }, [fetchProgress]);

  const overall = data?.overall;
  const overallPct = overall ? pct(overall.done, overall.total) : 0;
  const activeBookCount = data
    ? filterProgressBooks(data.books, "active").length
    : 0;
  const failedBookCount = data
    ? filterProgressBooks(data.books, "failed").length
    : 0;
  const effectiveBookFilter =
    data && bookFilter === "active" && activeBookCount === 0
      ? "all"
      : bookFilter;
  const filteredBooks = useMemo(
    () =>
      data
        ? filterProgressBooks(data.books, effectiveBookFilter)
        : [],
    [data, effectiveBookFilter],
  );
  const pagedBooks = useMemo(
    () => paginateProgressBooks(filteredBooks, bookPage, BOOKS_PAGE_SIZE),
    [filteredBooks, bookPage],
  );

  useEffect(() => {
    setBookPage(1);
  }, [effectiveBookFilter]);

  const chooseBookFilter = (filter: ProgressFilter) => {
    setBookFilter(filter);
    setBookPage(1);
  };

  return (
    <div className="min-h-screen px-6 py-10 sm:py-14 max-w-4xl mx-auto">
      <header className="mb-10 flex items-center gap-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
        <Link
          href="/"
          className="h-10 w-10 flex items-center justify-center rounded-full border border-border/60 text-foreground hover:bg-accent/60 hover:border-primary/40 hover:-translate-x-0.5 transition-all duration-200"
          aria-label="Back to library"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
        </Link>
        <div className="flex-1">
          <h1
            className="text-3xl font-medium tracking-tight"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            Translation Progress
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            {lastUpdated ? (
              <span>Last: {lastUpdated.toLocaleTimeString()}</span>
            ) : (
              <span>Loading…</span>
            )}
            {data?.activeProvider && (
              <span className="ml-2">· Provider: {data.activeProvider}</span>
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchProgress}
          disabled={refreshing}
          title="Reload translation progress"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {data?.recentFailure && (
        <FailureBanner failure={data.recentFailure} />
      )}

      {!data && !error && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}

      {data && (
        <>
          <section
            aria-label="Overall counts"
            className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6 animate-in fade-in duration-500"
          >
            <StatCard label="Done" value={overall!.done} tone="done" />
            <StatCard
              label="Processing"
              value={overall!.processing}
              tone="processing"
            />
            <StatCard label="Pending" value={overall!.pending} tone="pending" />
            <StatCard label="Failed" value={overall!.failed} tone="failed" />
          </section>

          <Card className="mb-6 border-border/50 shadow-sm animate-in fade-in duration-500 delay-75">
            <CardContent className="pt-6">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-sm text-muted-foreground">
                  Overall {overall!.done} / {overall!.total}
                </span>
                <span
                  className="text-2xl font-medium tabular-nums"
                  style={{ fontFamily: "var(--font-heading)" }}
                >
                  {overallPct.toFixed(1)}%
                </span>
              </div>
              <ProgressBar value={overallPct} />
              <div className="flex flex-wrap items-center justify-between gap-3 mt-3">
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    Throughput: {data.throughput.recentDone} in last{" "}
                    {Math.round(data.throughput.windowSeconds / 60)} min
                  </span>
                  <span>ETA: {formatEta(data.throughput.etaSeconds)}</span>
                </div>
                {overall!.failed > 0 && (
                  <div className="flex items-center gap-3">
                    {retryMessage && (
                      <span className="text-xs text-muted-foreground">
                        {retryMessage}
                      </span>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRetryFailed}
                      disabled={retrying}
                      title="Reset every failed translation back to pending"
                    >
                      {retrying ? "Resetting…" : `Retry ${overall!.failed} failed`}
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <section aria-label="Per-book breakdown" className="space-y-2">
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  By book
                </h2>
                {data.books.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Showing {pagedBooks.start}-{pagedBooks.end} of{" "}
                    {filteredBooks.length}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
                <FilterButton
                  label={`Active (${activeBookCount})`}
                  active={effectiveBookFilter === "active"}
                  onClick={() => chooseBookFilter("active")}
                  disabled={activeBookCount === 0}
                />
                <FilterButton
                  label={`Failed (${failedBookCount})`}
                  active={effectiveBookFilter === "failed"}
                  onClick={() => chooseBookFilter("failed")}
                  disabled={failedBookCount === 0}
                />
                <FilterButton
                  label={`All (${data.books.length})`}
                  active={effectiveBookFilter === "all"}
                  onClick={() => chooseBookFilter("all")}
                />
              </div>
            </div>
            {data.books.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No translations queued.
              </p>
            ) : filteredBooks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No books match this filter.
              </p>
            ) : (
              <>
                {pagedBooks.items.map((b) => (
                  <BookRow key={b.id} book={b} />
                ))}
                {pagedBooks.totalPages > 1 && (
                  <div className="flex items-center justify-between pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setBookPage(
                          getAdjacentProgressPage(
                            pagedBooks.page,
                            pagedBooks.totalPages,
                            -1,
                          ),
                        )
                      }
                      disabled={pagedBooks.page <= 1}
                    >
                      Previous
                    </Button>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      Page {pagedBooks.page} / {pagedBooks.totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setBookPage(
                          getAdjacentProgressPage(
                            pagedBooks.page,
                            pagedBooks.totalPages,
                            1,
                          ),
                        )
                      }
                      disabled={pagedBooks.page >= pagedBooks.totalPages}
                    >
                      Next
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>

          <div aria-live="polite" className="sr-only">
            Updated tick {tickRef.current}. {overall!.done} of {overall!.total}{" "}
            done.
          </div>
        </>
      )}
    </div>
  );
}

function FilterButton({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant={active ? "default" : "outline"}
      size="sm"
      disabled={disabled}
      onClick={onClick}
      className="h-7"
    >
      {label}
    </Button>
  );
}

function FailureBanner({
  failure,
}: {
  failure: { code: LLMErrorCode; message: string; at: string };
}) {
  // Tone by severity: quota/auth are blocking (amber), rate-limit/network
  // are transient (muted). Unknown errors stay visible but muted —
  // enough signal that something's wrong without crying wolf.
  const { code } = failure;
  const blocking =
    code === "quota_exhausted" ||
    code === "auth_error" ||
    code === "model_not_found";
  const toneClass = blocking
    ? "border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-200"
    : "border-border/50 bg-muted/40 text-muted-foreground";

  const headline = headlineFor(code);

  return (
    <div
      className={`mb-6 rounded-lg border px-4 py-3 text-sm flex items-start gap-3 ${toneClass}`}
      role="alert"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 shrink-0"
        aria-hidden
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <div className="flex-1 min-w-0">
        <div className="font-medium">{headline}</div>
        {failure.message && (
          <div className="text-xs opacity-80 mt-0.5 truncate">
            {stripCodePrefix(failure.message)}
          </div>
        )}
      </div>
    </div>
  );
}

function headlineFor(code: LLMErrorCode): string {
  switch (code) {
    case "quota_exhausted":
      return "API 额度不够 — 请充值后点 Retry failed";
    case "auth_error":
      return "API key 无效 — 请到 Settings 更新";
    case "model_not_found":
      return "模型未找到 — 请到 Settings 检查 model 名";
    case "rate_limit":
      return "被限流 — 稍等后点 Retry failed";
    case "network":
      return "网络错误 — 检查 Ollama / 网络连接";
    default:
      return "最近有翻译失败";
  }
}

function stripCodePrefix(message: string): string {
  return message.replace(/^\[[a-z_]+\]\s*/, "");
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "done" | "processing" | "pending" | "failed";
}) {
  // Muted/warm accent per status — matches the warm palette used across
  // the app, with just enough colour to scan at a glance.
  const toneClass =
    tone === "done"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "processing"
      ? "text-amber-600 dark:text-amber-400"
      : tone === "failed"
      ? "text-destructive"
      : "text-foreground";
  return (
    <Card className="border-border/50 shadow-sm">
      <CardContent className="py-4 px-4">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div
          className={`text-2xl font-medium tabular-nums mt-1 ${toneClass}`}
          style={{ fontFamily: "var(--font-heading)" }}
        >
          {value.toLocaleString()}
        </div>
      </CardContent>
    </Card>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div
      className="h-2 rounded-full bg-muted overflow-hidden"
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full bg-primary transition-[width] duration-500 ease-out"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

function BookRow({ book }: { book: BookProgress }) {
  const p = pct(book.done, book.total);
  const active = book.pending + book.processing;
  return (
    <div className="flex items-stretch gap-3 rounded-lg border border-border/50 bg-card/50 px-3 py-3">
      {/* Small 2:3 thumbnail — ~36px wide, shelf-friendly scale that
          doesn't compete with the progress data. Falls back to a Fraunces
          letter when the book has no cover uploaded. */}
      <div className="relative w-9 sm:w-11 aspect-[2/3] shrink-0 overflow-hidden rounded bg-muted/40">
        {book.hasCover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/books/${book.id}/cover`}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div
            className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground/60 select-none"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            {book.title.trim().charAt(0) || "?"}
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-4 mb-2">
          <span className="text-sm font-medium truncate">{book.title}</span>
          <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
            {book.done} / {book.total}
            {book.failed > 0 && (
              <span className="ml-2 text-destructive">· {book.failed} failed</span>
            )}
          </span>
        </div>
        <ProgressBar value={p} />
        <div className="text-[11px] text-muted-foreground mt-1.5 tabular-nums">
          {book.doneChapters} / {book.totalChapters} chapters
          {active > 0 && <span className="ml-2">· {active} in flight</span>}
        </div>
      </div>
    </div>
  );
}
