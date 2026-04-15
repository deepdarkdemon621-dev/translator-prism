"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";

interface CollectionCardProps {
  collection: {
    id: string;
    name: string;
    bookCount: number;
    coverBookId: string | null;
    coverPath: string | null;
    userId?: string;
    visibility?: "public" | "private";
  };
  currentUserId?: string;
  isAdmin?: boolean;
  /** When true, clicks toggle `selected` rather than navigating. */
  selectMode?: boolean;
  selected?: boolean;
  onSelectToggle?: (id: string) => void;
}

/**
 * Tile for one collection on the library page. Mirrors BookCard's
 * visual rhythm (same 3:4 cover strip) so the two grids line up when
 * rendered side by side. Cover is inherited from the collection's
 * first-by-seq book — fetched via the book-cover API, not a separate
 * collection-cover endpoint.
 */
export function CollectionCard({
  collection,
  currentUserId,
  isAdmin,
  selectMode = false,
  selected = false,
  onSelectToggle,
}: CollectionCardProps) {
  const { id, name, bookCount, coverBookId, coverPath } = collection;
  const isOther =
    !!isAdmin && !!collection.userId && !!currentUserId && collection.userId !== currentUserId;

  const body = (
    <Card
      className={`overflow-hidden border-border/50 shadow-sm hover:shadow-xl hover:-translate-y-0.5 hover:border-primary/30 transition-all duration-300 ease-out ${
        selected ? "ring-2 ring-primary ring-offset-2" : ""
      }`}
    >
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-muted/40">
        {coverBookId && coverPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/books/${coverBookId}/cover`}
            alt={`${name} cover`}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div
            className="absolute inset-0 flex items-center justify-center text-5xl font-medium text-muted-foreground/50 select-none"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            {name.trim().charAt(0) || "?"}
          </div>
        )}
        <div className="pointer-events-none absolute inset-y-2 right-0 flex flex-col gap-1.5">
          <div className="h-full w-1 bg-background/40 rounded-l-sm shadow-[inset_1px_0_0_rgba(0,0,0,0.1)]" />
        </div>
        {isOther && (
          <div
            className="absolute top-2 left-2 rounded-sm bg-background/85 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-medium shadow-sm"
            title="Owned by another user"
          >
            @other
          </div>
        )}
        <div className="absolute bottom-2 right-2 rounded-full bg-background/85 backdrop-blur-sm px-2 py-0.5 text-[10px] font-medium tabular-nums shadow-sm">
          {bookCount}
        </div>
      </div>
      <div className="p-4">
        <h3
          className="font-medium tracking-tight truncate group-hover:text-primary transition-colors"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          {name}
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {bookCount === 1 ? "1 book" : `${bookCount} books`}
        </p>
      </div>
    </Card>
  );

  if (selectMode && onSelectToggle) {
    return (
      <div
        className="relative block group cursor-pointer"
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSelectToggle(id);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelectToggle(id);
          }
        }}
      >
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
        <div className="pointer-events-none">{body}</div>
      </div>
    );
  }

  return (
    <Link href={`/collections/${id}`} className="block group">
      {body}
    </Link>
  );
}
