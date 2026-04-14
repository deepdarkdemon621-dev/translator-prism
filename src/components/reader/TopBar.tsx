"use client";

import { Button } from "@/components/ui/button";
import Link from "next/link";

export type ViewMode = "single" | "dual" | "triple";

interface TopBarProps {
  bookTitle: string;
  chapterTitle: string;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  fontSize: number;
  onFontSizeChange: (delta: number) => void;
}

export function TopBar({
  bookTitle,
  chapterTitle,
  viewMode,
  onViewModeChange,
  onToggleSidebar,
  onOpenSettings,
  fontSize,
  onFontSizeChange,
}: TopBarProps) {
  return (
    <div className="flex items-center justify-between px-5 py-2.5 bg-background/70 backdrop-blur-xl border-b border-border/50 text-sm animate-in fade-in slide-in-from-top-2 duration-500">
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={onToggleSidebar}
          className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
          aria-label="Toggle table of contents"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <Link
          href="/"
          className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
          aria-label="Back to library"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
        </Link>
        <div className="flex items-baseline gap-2 min-w-0">
          <span
            className="font-medium truncate tracking-tight"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            {bookTitle}
          </span>
          {chapterTitle && (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span className="text-muted-foreground truncate text-xs">{chapterTitle}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <div className="flex items-center gap-0.5 rounded-full bg-muted/60 p-0.5">
          {(["single", "dual", "triple"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => onViewModeChange(mode)}
              className={`text-xs h-7 px-3 rounded-full transition-all duration-200 font-medium ${
                viewMode === mode
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {mode === "single" ? "単語" : mode === "dual" ? "二語" : "三語"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5 rounded-full bg-muted/60 p-0.5 ml-1">
          <button
            onClick={() => onFontSizeChange(-1)}
            className="text-xs h-7 w-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-background transition-colors font-medium"
            aria-label="Decrease font size"
          >
            A−
          </button>
          <span
            className="text-[10px] text-muted-foreground tabular-nums px-1.5 min-w-[2ch] text-center"
            aria-label={`Font size ${fontSize}px`}
          >
            {fontSize}
          </span>
          <button
            onClick={() => onFontSizeChange(1)}
            className="text-sm h-7 w-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-background transition-colors font-medium"
            aria-label="Increase font size"
          >
            A+
          </button>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="text-xs h-8 px-3 ml-1 text-muted-foreground hover:text-foreground"
          onClick={onOpenSettings}
          aria-label="Reader settings"
        >
          Aa
        </Button>
      </div>
    </div>
  );
}
