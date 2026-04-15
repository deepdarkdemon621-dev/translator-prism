"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SessionUser {
  id: string;
  credits: number;
  isAdmin: boolean;
}

const PRESET_AMOUNTS = [50, 200, 1000];

/**
 * Header pill that shows the current credit balance and opens a fake
 * top-up dialog on click. Uses a local refresh counter so sibling UI
 * (e.g. the pricing dialog) can trigger a re-fetch — for now we just
 * re-poll on dialog close to keep the flow simple.
 */
export function CreditsBadge() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Bumping this counter triggers a re-fetch. Kept separate from setUser
  // so the effect treats the request as an external-state subscription —
  // the lint rule `react-hooks/set-state-in-effect` dislikes synchronous
  // setState in effect bodies, but setState inside the promise resolve
  // callback is the sanctioned escape hatch.
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/user")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SessionUser | null) => {
        if (!cancelled && data) setUser(data);
      })
      .catch(() => {
        // Silently ignore — header badge isn't load-bearing.
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(open) => {
        setDialogOpen(open);
        // When the dialog closes, re-fetch so a successful top-up is
        // reflected even if the user closed with the escape key.
        if (!open) setRefreshTick((n) => n + 1);
      }}
    >
      <DialogTrigger
        className="px-3 py-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors text-sm tabular-nums"
        aria-label="Credits balance — click to top up"
      >
        {user ? `${user.credits} cr` : "…"}
      </DialogTrigger>
      <TopUpDialogBody
        currentBalance={user?.credits ?? 0}
        onCompleted={(newBalance) => {
          setUser((u) => (u ? { ...u, credits: newBalance } : u));
        }}
      />
    </Dialog>
  );
}

function TopUpDialogBody({
  currentBalance,
  onCompleted,
}: {
  currentBalance: number;
  onCompleted: (newBalance: number) => void;
}) {
  const [custom, setCustom] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const topUp = async (amount: number) => {
    if (amount <= 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/user/credits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Top-up failed");
      onCompleted(data.credits);
      // Let any open dialog relying on a credit snapshot (e.g. PricingDialog)
      // refresh — otherwise its Buy buttons stay disabled on the stale
      // balance it fetched before the top-up.
      window.dispatchEvent(new CustomEvent("credits-changed"));
      setCustom("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const customAmount = Number(custom);
  const customValid =
    custom.length > 0 && Number.isFinite(customAmount) && customAmount > 0;

  return (
    <DialogContent className="max-w-sm">
      <DialogHeader>
        <DialogTitle>Top up credits</DialogTitle>
        <DialogDescription>
          Dev-only flow: credits are added directly. Real payments will use
          Stripe / Alipay once the flow lands. Current balance:{" "}
          <span className="font-medium text-foreground tabular-nums">
            {currentBalance} cr
          </span>
          .
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          {PRESET_AMOUNTS.map((amount) => (
            <Button
              key={amount}
              variant="outline"
              size="sm"
              disabled={submitting}
              onClick={() => topUp(amount)}
            >
              +{amount}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            placeholder="Custom amount"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            disabled={submitting}
          />
          <Button
            size="sm"
            disabled={!customValid || submitting}
            onClick={() => topUp(customAmount)}
          >
            Add
          </Button>
        </div>
        {error && <p className="text-destructive text-sm">{error}</p>}
      </div>
      <DialogFooter>
        <DialogClose
          render={
            <Button variant="ghost" onClick={() => setCustom("")}>
              Close
            </Button>
          }
        />
      </DialogFooter>
    </DialogContent>
  );
}
