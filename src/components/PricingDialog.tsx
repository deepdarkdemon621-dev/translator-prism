"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface TierQuote {
  bundle: "first3" | "first10" | "full";
  chapterLimit: number | null;
  discountPct: number;
  chapterIds: string[];
  alreadyOwned: number;
  newCharges: number;
  credits: number;
}

interface PricingResponse {
  bookId: string;
  visibility: "public" | "private";
  userCredits: number;
  tiers: TierQuote[];
}

interface PricingDialogProps {
  bookId: string | null;
  bookTitle?: string;
  onDone: () => void;
}

/**
 * Post-upload gate: shows the user how many credits each bundle costs
 * for their freshly uploaded private book, plus a "Skip for now" exit.
 *
 * Skipping is legitimate — the book sits in the library with zero
 * translated chapters and the same tiers are available later from the
 * book's detail page (wired in a follow-up). The point here is to
 * convert the upload intent directly into a purchase while context is
 * still fresh.
 */
export function PricingDialog({ bookId, bookTitle, onDone }: PricingDialogProps) {
  const [data, setData] = useState<PricingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isOpen = bookId != null;

  const load = useCallback(async () => {
    if (!bookId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/books/${bookId}/pricing`);
      if (!res.ok) throw new Error("Failed to load pricing");
      setData((await res.json()) as PricingResponse);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    if (bookId) load();
    else {
      setData(null);
      setError(null);
    }
  }, [bookId, load]);

  // Refetch when the user tops up in the sibling CreditsBadge — otherwise
  // our `userCredits` snapshot goes stale and Buy stays "Low balance".
  useEffect(() => {
    if (!bookId) return;
    const handler = () => load();
    window.addEventListener("credits-changed", handler);
    return () => window.removeEventListener("credits-changed", handler);
  }, [bookId, load]);

  const handlePurchase = async (bundle: TierQuote["bundle"]) => {
    if (!bookId) return;
    setPurchasing(bundle);
    setError(null);
    try {
      const res = await fetch(`/api/books/${bookId}/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundle }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Purchase failed");
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPurchasing(null);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onDone()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Unlock translations</DialogTitle>
          <DialogDescription>
            {bookTitle ? (
              <>
                <span className="font-medium text-foreground">{bookTitle}</span>
                {" — "}
              </>
            ) : null}
            Pick a bundle to start translating, or skip and decide later.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Loading pricing…
          </div>
        ) : data ? (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              Balance: <span className="font-medium text-foreground">{data.userCredits} credits</span>
            </div>
            {data.tiers.map((tier) => {
              const insufficient = data.userCredits < tier.credits;
              return (
                <div
                  key={tier.bundle}
                  className="flex items-center justify-between gap-4 rounded-xl border border-border/60 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium">{labelFor(tier)}</span>
                      {tier.discountPct > 0 && (
                        <span className="text-xs text-primary">
                          {tier.discountPct}% off
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {tier.newCharges} new
                      {tier.alreadyOwned > 0 ? `, ${tier.alreadyOwned} already owned` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <div className="text-sm font-medium tabular-nums">
                        {tier.credits} cr
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={insufficient ? "outline" : "default"}
                      disabled={
                        purchasing !== null ||
                        tier.chapterIds.length === 0 ||
                        tier.newCharges === 0 ||
                        insufficient
                      }
                      onClick={() => handlePurchase(tier.bundle)}
                    >
                      {purchasing === tier.bundle
                        ? "…"
                        : insufficient
                          ? "Low balance"
                          : tier.newCharges === 0
                            ? "Owned"
                            : "Buy"}
                    </Button>
                  </div>
                </div>
              );
            })}
            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>
        ) : error ? (
          <p className="text-destructive text-sm py-4">{error}</p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onDone} disabled={purchasing !== null}>
            Skip for now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function labelFor(tier: TierQuote): string {
  if (tier.chapterLimit == null) return "Full book";
  return `First ${tier.chapterLimit} chapters`;
}
