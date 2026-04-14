/**
 * Client-side helper for the batch translate-all endpoints.
 *
 * Wraps the two-phase cost-gate handshake the paid-provider routes use:
 * first POST returns an estimate; second POST with ?confirm=1 queues. A
 * local Ollama provider skips phase 1 entirely. We put the confirm UI
 * behind a plain window.confirm() here — admin-only flow, not worth a
 * bespoke dialog yet.
 *
 * Returns a brief status the caller renders in a toast.
 */
export interface TranslateAllSummary {
  queued: number;
  chaptersQueued?: number;
  cancelled?: boolean;
  error?: string;
}

export async function translateAllWithGate(
  endpoint: string,
): Promise<TranslateAllSummary> {
  // Phase 1: estimate (no-op for Ollama — it just queues).
  const first = await fetch(endpoint, { method: "POST" });
  if (!first.ok) {
    return { queued: 0, error: (await first.text()) || `HTTP ${first.status}` };
  }
  const firstData = await first.json();
  if (!firstData.requiresConfirm) {
    // Local provider: already queued, done.
    return {
      queued: firstData.queued || 0,
      chaptersQueued: firstData.chaptersQueued,
    };
  }

  // Phase 2: confirm cost.
  const cost =
    typeof firstData.estimatedCostUsd === "number"
      ? `~$${firstData.estimatedCostUsd.toFixed(2)}`
      : "unknown cost";
  const tokens =
    typeof firstData.estimatedInputTokens === "number"
      ? `${firstData.estimatedInputTokens.toLocaleString()} tokens`
      : "unknown tokens";
  const chapters =
    firstData.chaptersToQueue ?? firstData.booksToQueue ?? "?";
  const msg = `Batch translate will queue ${chapters} chapters/books via ${firstData.provider} (paid).\n\nEstimate: ${tokens} ≈ ${cost}\n\nProceed?`;
  if (!confirm(msg)) {
    return { queued: 0, cancelled: true };
  }

  const sep = endpoint.includes("?") ? "&" : "?";
  const second = await fetch(`${endpoint}${sep}confirm=1`, { method: "POST" });
  if (!second.ok) {
    return { queued: 0, error: `HTTP ${second.status}` };
  }
  const secondData = await second.json();
  return {
    queued: secondData.queued || 0,
    chaptersQueued: secondData.chaptersQueued,
  };
}
