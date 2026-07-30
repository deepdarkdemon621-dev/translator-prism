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

// Legacy books can defer expensive per-chapter extraction past the server
// time budget; the route reports how many chapters remain so we keep
// re-POSTing until the whole book is queued. Bounded to avoid a loop if
// the server keeps reporting a remainder.
const MAX_CONTINUATIONS = 10;

async function drainRemaining(
  endpoint: string,
  data: { queued?: number; chaptersQueued?: number; remainingChapters?: number },
): Promise<TranslateAllSummary> {
  let queued = data.queued || 0;
  let chaptersQueued = data.chaptersQueued || 0;
  let remaining = data.remainingChapters ?? 0;
  const sep = endpoint.includes("?") ? "&" : "?";
  for (let i = 0; remaining > 0 && i < MAX_CONTINUATIONS; i++) {
    const res = await fetch(`${endpoint}${sep}confirm=1`, { method: "POST" });
    if (!res.ok) {
      return { queued, chaptersQueued, error: `HTTP ${res.status}` };
    }
    const next = await res.json();
    queued += next.queued || 0;
    chaptersQueued += next.chaptersQueued || 0;
    remaining = next.remainingChapters ?? 0;
  }
  return { queued, chaptersQueued };
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
    // Local provider: already queued; continue any deferred remainder.
    return drainRemaining(endpoint, firstData);
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
  return drainRemaining(endpoint, secondData);
}
