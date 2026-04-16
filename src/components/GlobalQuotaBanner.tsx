"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";

interface SystemStatus {
  quotaExhausted: boolean;
  authError: boolean;
  recentCode: string | null;
}

// Paths that render their own richer banner OR where a global banner is
// actively harmful (the clerk sign-in forms shouldn't show anything we
// control). Progress page is excluded because its in-card banner already
// carries the retry button.
const SKIP_PATH_PREFIXES = ["/progress", "/sign-in", "/sign-up"];

/**
 * App-wide banner that surfaces blocking LLM states (quota exhausted,
 * auth error) on every page. Lives at the top of the layout so the
 * user can't miss it while they're browsing the library or reading.
 *
 * Fetches once per path change instead of polling — the previous 30s
 * interval was scanning the translations table on every tick and
 * dominated our Turso row-read budget. Users who want a fresh view
 * can navigate or open /progress (which has its own in-card banner).
 */
export function GlobalQuotaBanner() {
  const pathname = usePathname();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const skip = SKIP_PATH_PREFIXES.some((p) => pathname.startsWith(p));

  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/system-status", { cache: "no-store" });
        if (!res.ok) return;
        const json: SystemStatus = await res.json();
        if (!cancelled) setStatus(json);
      } catch {
        // Swallow — probe failures shouldn't break the UI.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skip, pathname]);

  // Reset dismiss state when the status changes between blocking/non-blocking.
  // Means: after the user clicks retry and the queue clears, the banner
  // goes away; if a NEW block appears later the dismissed state resets so
  // they see it again.
  useEffect(() => {
    if (!status || (!status.quotaExhausted && !status.authError)) {
      setDismissed(false);
    }
  }, [status]);

  if (skip) return null;
  if (!status) return null;
  if (!status.quotaExhausted && !status.authError) return null;
  if (dismissed) return null;

  const isQuota = status.quotaExhausted;
  const headline = isQuota
    ? "API 额度不够 — 翻译已暂停"
    : "API key 无效 — 翻译已暂停";
  const cta = isQuota ? "充值后点 Retry" : "到 Settings 更新";
  const href = isQuota ? "/progress" : "/settings";

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 border-b border-amber-500/40 bg-amber-500/15 backdrop-blur-sm text-amber-900 dark:text-amber-100"
    >
      <div className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-3 text-sm">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
          aria-hidden
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span className="flex-1 min-w-0 truncate font-medium">{headline}</span>
        <Link
          href={href}
          className="px-3 py-1 rounded-full bg-amber-600/20 hover:bg-amber-600/30 transition-colors whitespace-nowrap text-xs font-medium"
        >
          {cta} →
        </Link>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="p-1 rounded hover:bg-amber-600/20 transition-colors shrink-0"
          aria-label="Dismiss"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
