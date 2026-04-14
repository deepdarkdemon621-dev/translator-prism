"use client";

import { Button } from "@/components/ui/button";

interface BottomBarProps {
  currentIndex: number;
  totalChapters: number;
  onPrev: () => void;
  onNext: () => void;
}

export function BottomBar({
  currentIndex,
  totalChapters,
  onPrev,
  onNext,
}: BottomBarProps) {
  const progress =
    totalChapters > 0
      ? Math.round(((currentIndex + 1) / totalChapters) * 100)
      : 0;

  return (
    <div className="relative bg-background/70 backdrop-blur-xl border-t border-border/50">
      <div
        className="absolute top-0 left-0 h-px bg-primary transition-all duration-500 ease-out"
        style={{ width: `${progress}%` }}
      />
      <div className="flex items-center justify-between px-5 py-2 text-xs text-muted-foreground">
        <Button
          variant="ghost"
          size="sm"
          className="text-xs h-7 px-3 hover:text-foreground disabled:opacity-30"
          onClick={onPrev}
          disabled={currentIndex <= 0}
        >
          ← Prev
        </Button>
        <span className="tabular-nums font-medium tracking-wide">
          {currentIndex + 1} <span className="text-muted-foreground/50">/</span> {totalChapters}
          <span className="mx-2 text-muted-foreground/30">·</span>
          {progress}%
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs h-7 px-3 hover:text-foreground disabled:opacity-30"
          onClick={onNext}
          disabled={currentIndex >= totalChapters - 1}
        >
          Next →
        </Button>
      </div>
    </div>
  );
}
