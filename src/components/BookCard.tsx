"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import Link from "next/link";
import { translateAllWithGate } from "@/lib/translate/client";

interface BookCardProps {
  book: {
    id: string;
    title: string;
    author: string;
    sourceLang: string;
    totalChapters: number;
    translatedChapters: number;
    status: string;
    /** Storage key of the cover image, or null if the EPUB had none.
     * Presence toggles the <img> vs. the placeholder tile. */
    coverPath?: string | null;
    /** Count of translations still pending or processing for this book.
     * Drives the Cancel button: shown only when > 0. */
    pendingTranslations?: number;
    userId?: string | null;
    collectionId?: string | null;
  };
  currentUserId?: string;
  isAdmin?: boolean;
  /** Collections available as move destinations. Should be the caller's
   * own collections; passing an admin-public collection the caller
   * doesn't own will be silently rejected by the server. */
  collections?: Array<{ id: string; name: string }>;
  onDelete: (id: string) => void;
  onMove?: (bookId: string, collectionId: string | null) => void;
  /** Notify parent when a translate/cancel finished so the list can refetch
   * and update counts. Optional — older call-sites work without it. */
  onChange?: () => void;
  /** When true, the card becomes a selection target: clicking it toggles
   *  `selected` via `onSelectToggle` instead of navigating to Read. */
  selectMode?: boolean;
  selected?: boolean;
  onSelectToggle?: (id: string) => void;
}

const LANG_LABELS: Record<string, string> = {
  ja: "日本語",
  zh: "中文",
  en: "English",
};

export function BookCard({
  book,
  currentUserId,
  isAdmin,
  collections,
  onDelete,
  onMove,
  onChange,
  selectMode = false,
  selected = false,
  onSelectToggle,
}: BookCardProps) {
  const progress =
    book.totalChapters > 0
      ? Math.round((book.translatedChapters / book.totalChapters) * 100)
      : 0;
  const [translating, setTranslating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const fullyTranslated = book.translatedChapters >= book.totalChapters && book.totalChapters > 0;
  const hasPending = (book.pendingTranslations ?? 0) > 0;

  const handleTranslateAll = async () => {
    setTranslating(true);
    try {
      const res = await translateAllWithGate(`/api/books/${book.id}/translate-all`);
      if (res.cancelled) return;
      if (res.error) {
        alert(`Translate failed: ${res.error}`);
        return;
      }
      if (res.queued > 0) {
        alert(`Queued ${res.queued} translations${res.chaptersQueued ? ` across ${res.chaptersQueued} chapters` : ""}.`);
        onChange?.();
      } else {
        alert("Nothing to translate — everything looks done.");
      }
    } finally {
      setTranslating(false);
    }
  };

  const handleCancel = async () => {
    if (!confirm(`Cancel ${book.pendingTranslations} pending translation(s) for this book? In-flight calls can't be stopped but their results will be discarded.`)) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/books/${book.id}/translate-cancel`, { method: "POST" });
      if (!res.ok) {
        alert(`Cancel failed: ${await res.text()}`);
        return;
      }
      const data = await res.json();
      alert(`Cancelled ${data.cancelled} translation(s).`);
      onChange?.();
    } finally {
      setCancelling(false);
    }
  };

  const selectHandlers = selectMode && onSelectToggle
    ? {
        onClick: (e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          onSelectToggle(book.id);
        },
        role: "button" as const,
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelectToggle(book.id);
          }
        },
      }
    : {};

  return (
    <div className="relative" {...selectHandlers}>
      {selectMode && (
        <div
          className={`absolute top-2 left-2 z-10 h-5 w-5 rounded border-2 flex items-center justify-center pointer-events-none transition-colors ${
            selected
              ? "bg-primary border-primary text-primary-foreground"
              : "bg-background/90 border-border/80"
          }`}
          aria-hidden
        >
          {selected && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </div>
      )}
      <Card
        className={`overflow-hidden border-border/50 shadow-sm hover:shadow-xl hover:-translate-y-0.5 hover:border-primary/30 transition-all duration-300 ease-out group ${
          selectMode ? "cursor-pointer" : ""
        } ${selected ? "ring-2 ring-primary ring-offset-2" : ""}`}
      >
      <div className="flex">
        {/* Cover thumbnail — left side, fixed width, 2:3 book proportion.
            Using a fixed width (not aspect) so the content column can flex
            to fill the remaining card width regardless of card size. */}
        <div className={`relative w-20 sm:w-24 aspect-[2/3] shrink-0 overflow-hidden bg-muted/40 ${selectMode ? "pointer-events-none" : ""}`}>
          {book.coverPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/books/${book.id}/cover`}
              alt={`${book.title} cover`}
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            />
          ) : (
            <div
              className="absolute inset-0 flex items-center justify-center text-3xl font-medium text-muted-foreground/50 select-none"
              style={{ fontFamily: "var(--font-heading)" }}
            >
              {book.title.trim().charAt(0) || "?"}
            </div>
          )}
          {isAdmin && book.userId && currentUserId && book.userId !== currentUserId && (
            <span
              className="absolute top-1 left-1 rounded-sm bg-background/85 backdrop-blur-sm px-1 text-[9px] font-medium tabular-nums shadow-sm"
              title="Owned by another user"
            >
              @other
            </span>
          )}
        </div>
        <CardContent className={`flex-1 min-w-0 p-3 flex flex-col justify-between ${selectMode ? "pointer-events-none" : ""}`}>
          <div>
            <div className="flex items-start justify-between gap-2 mb-1">
              <h3
                className="font-medium text-sm tracking-tight line-clamp-2 group-hover:text-primary transition-colors duration-300"
                style={{ fontFamily: "var(--font-heading)" }}
              >
                {book.title}
              </h3>
              <Badge
                variant="secondary"
                className="shrink-0 text-[9px] uppercase tracking-wider font-medium px-1.5"
              >
                {LANG_LABELS[book.sourceLang] || book.sourceLang}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground truncate mb-2">{book.author}</p>
            <div className="flex items-center gap-2 mb-2">
              <Progress value={progress} className="h-1 flex-1" />
              <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                {book.translatedChapters}/{book.totalChapters}
              </span>
            </div>
          </div>

          <div className="flex gap-1.5">
            <Button
              size="sm"
              className="flex-1 shadow-sm h-7 text-xs"
              nativeButton={false}
              render={<Link href={`/read/${book.id}`}>Read</Link>}
            />
            {/* Translate-all: any caller can hit it; server rejects if the
                caller doesn't own the book. Hidden when 100% done so the
                button row stays short for finished books. When there's
                pending work the button becomes Cancel instead — same slot,
                avoids crowding the card. */}
            {!fullyTranslated && (
              hasPending ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancel}
                  disabled={cancelling}
                  title={`Cancel ${book.pendingTranslations} pending translation(s)`}
                  className="h-7 text-xs px-2 text-destructive hover:bg-destructive/10 hover:border-destructive/40"
                >
                  {cancelling ? "…" : `Cancel (${book.pendingTranslations})`}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTranslateAll}
                  disabled={translating}
                  title="Queue every remaining chapter"
                  className="h-7 text-xs px-2"
                >
                  {translating ? "…" : "Translate"}
                </Button>
              )
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-7 px-0 text-muted-foreground"
                    aria-label="More actions"
                  >
                    ⋯
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-44">
                {onMove && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Move to…</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {book.collectionId !== null && book.collectionId !== undefined && (
                        <DropdownMenuItem onClick={() => onMove(book.id, null)}>
                          Top level
                        </DropdownMenuItem>
                      )}
                      {(collections ?? [])
                        .filter((c) => c.id !== book.collectionId)
                        .map((c) => (
                          <DropdownMenuItem
                            key={c.id}
                            onClick={() => onMove(book.id, c.id)}
                          >
                            {c.name}
                          </DropdownMenuItem>
                        ))}
                      {(collections ?? []).length === 0 && book.collectionId == null && (
                        <DropdownMenuItem disabled>No collections</DropdownMenuItem>
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => {
                    if (confirm("Delete this book and all translations?")) onDelete(book.id);
                  }}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardContent>
      </div>
      </Card>
    </div>
  );
}
