"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface SelectionBarProps {
  /** How many items are selected. Drives label + disables actions when 0. */
  count: number;
  /** Total items available for "Select all". */
  total: number;
  /** Label for the unit in the count ("book" / "collection"). Pluralized
   *  by the bar itself. */
  noun: string;
  onSelectAll: () => void;
  onClear: () => void;
  onDone: () => void;
  /** Action buttons (Delete, Move to collection, etc.) — each caller
   *  renders its own since the set differs per surface. */
  children: ReactNode;
}

/**
 * Sticky bottom bar for multi-select. Gated at `sm:` so touch viewports
 * never see the select-mode UI — matches the spec's desktop-only scope.
 */
export function SelectionBar({
  count,
  total,
  noun,
  onSelectAll,
  onClear,
  onDone,
  children,
}: SelectionBarProps) {
  const plural = count === 1 ? noun : `${noun}s`;
  return (
    <div className="hidden sm:block fixed bottom-6 left-1/2 -translate-x-1/2 z-40 animate-in fade-in slide-in-from-bottom-4 duration-200">
      <div className="flex items-center gap-3 rounded-full border border-border/60 bg-background/95 backdrop-blur shadow-lg px-4 py-2">
        <span className="text-sm tabular-nums">
          <span className="font-medium">{count}</span>{" "}
          <span className="text-muted-foreground">{plural} selected</span>
        </span>
        <button
          type="button"
          onClick={count === total ? onClear : onSelectAll}
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-4 transition-colors"
        >
          {count === total && total > 0 ? "Clear" : "Select all"}
        </button>
        <div className="h-5 w-px bg-border/60 mx-1" />
        {children}
        <div className="h-5 w-px bg-border/60 mx-1" />
        <Button variant="ghost" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
