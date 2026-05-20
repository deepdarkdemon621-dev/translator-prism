"use client";

import { Button } from "@/components/ui/button";
import type { ReaderLang } from "@/lib/reader/language-selection";
import Link from "next/link";

interface TopBarProps {
  bookTitle: string;
  chapterTitle: string;
  visibleLangs: ReaderLang[];
  onToggleLanguage: (lang: ReaderLang) => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  fontSize: number;
  onFontSizeChange: (delta: number) => void;
}

const LANGUAGE_OPTIONS: Array<{ lang: ReaderLang; label: string; title: string }> = [
  { lang: "ja", label: "日", title: "Japanese" },
  { lang: "zh", label: "中", title: "Chinese" },
  { lang: "en", label: "EN", title: "English" },
];

export function TopBar({
  bookTitle,
  chapterTitle,
  visibleLangs,
  onToggleLanguage,
  onToggleSidebar,
  onOpenSettings,
  fontSize,
  onFontSizeChange,
}: TopBarProps) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 sm:px-5 py-2.5 bg-background/70 backdrop-blur-xl border-b border-border/50 text-sm animate-in fade-in slide-in-from-top-2 duration-500">
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
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
              <span className="hidden sm:inline text-muted-foreground/50">/</span>
              <span className="hidden sm:inline text-muted-foreground truncate text-xs">
                {chapterTitle}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <div className="flex items-center gap-0.5 rounded-full bg-muted/60 p-0.5" aria-label="Visible languages">
          {LANGUAGE_OPTIONS.map(({ lang, label, title }) => {
            const isVisible = visibleLangs.includes(lang);
            const isLastVisible = isVisible && visibleLangs.length === 1;
            return (
              <button
                key={lang}
                type="button"
                onClick={() => onToggleLanguage(lang)}
                disabled={isLastVisible}
                title={isLastVisible ? `${title} is the last visible language` : title}
                aria-pressed={isVisible}
                className={`text-xs h-7 px-2.5 sm:px-3 rounded-full transition-all duration-200 font-medium ${
                  isVisible
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                } disabled:cursor-not-allowed disabled:opacity-70`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="hidden sm:flex items-center gap-0.5 rounded-full bg-muted/60 p-0.5 ml-1">
          <button
            onClick={() => onFontSizeChange(-1)}
            className="text-xs h-7 w-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-background transition-colors font-medium"
            aria-label="Decrease font size"
          >
            A-
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
          className="text-xs h-8 px-2.5 sm:px-3 ml-0 sm:ml-1 text-muted-foreground hover:text-foreground"
          onClick={onOpenSettings}
          aria-label="Reader settings"
        >
          Aa
        </Button>
      </div>
    </div>
  );
}
