# Library Multi-Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add desktop-only checkbox multi-select to Prism's library UI for bulk deleting books, bulk deleting collections (with cascade to contained books), and bulk moving books in/out of collections.

**Architecture:** Two new bulk API endpoints (`/api/books/bulk`, `/api/collections/bulk`) loop existing single-item operations. Client side gets one small `useSelection` hook, one `SelectionBar` component, and select-mode props on `BookCard` / `CollectionCard`. Home page wires two independent selection instances (Library and Collections). Collection detail page wires one for its books list.

**Tech Stack:** Next.js 16 (App Router, Turbopack), React 19 client components, Drizzle ORM over libsql, Clerk auth via existing `getCurrentUser`. No new deps.

**Spec:** `docs/superpowers/specs/2026-04-15-library-multi-select-design.md`

**Testing policy:** Manual smoke only, per spec. No unit or route tests are added — the backend loops existing single-item ops already exercised by smoke and previously-written integration paths, and the React hook is too thin to warrant a test harness. Each task ends with a concrete manual verification step.

---

### Task 1: `useSelection` hook

**Files:**
- Create: `src/components/library/useSelection.ts`

A tiny state container shared by all three surfaces. Keeps selection and mode in React state; owns no fetch logic.

- [ ] **Step 1: Create the hook file**

Write this exact content to `src/components/library/useSelection.ts`:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Selection + select-mode state for a single grid (Library, Collections,
 * or a collection's books list). Intentionally small — the hook owns
 * *what's selected*, not *what to do with it*. Callers render their
 * own action bar and call the bulk endpoints themselves.
 *
 * Attaching to `document` for the Esc-to-exit listener is safe because
 * the listener is only bound while `mode === true`.
 */
export interface UseSelectionApi {
  mode: boolean;
  selected: Set<string>;
  enter: () => void;
  exit: () => void;
  toggle: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clear: () => void;
  remove: (ids: string[]) => void;
}

export function useSelection(): UseSelectionApi {
  const [mode, setMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const enter = useCallback(() => {
    setMode(true);
  }, []);

  const exit = useCallback(() => {
    setMode(false);
    setSelected(new Set());
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    setSelected(new Set(ids));
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const remove = useCallback((ids: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!mode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode, exit]);

  return { mode, selected, enter, exit, toggle, selectAll, clear, remove };
}
```

- [ ] **Step 2: Manual verification**

Run: `npx tsc --noEmit`
Expected: no errors. (Hook has no runtime test; it's exercised by later tasks.)

- [ ] **Step 3: Commit**

```bash
git add src/components/library/useSelection.ts
git commit -m "feat(library): add useSelection hook for multi-select state"
```

---

### Task 2: `SelectionBar` component

**Files:**
- Create: `src/components/library/SelectionBar.tsx`

Floating action bar rendered at the bottom of the viewport while any selection mode is active. Surface-agnostic — the calling page supplies the action buttons as children and passes in the count + selectAll/clear/done callbacks.

- [ ] **Step 1: Create the component**

Write this exact content to `src/components/library/SelectionBar.tsx`:

```tsx
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
```

- [ ] **Step 2: Manual verification**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/library/SelectionBar.tsx
git commit -m "feat(library): add SelectionBar floating action component"
```

---

### Task 3: Backend — `POST /api/books/bulk`

**Files:**
- Create: `src/app/api/books/bulk/route.ts`

Loops existing per-book delete or `moveBookToCollection` once per id. Returns `{ succeeded, failed }` so the client can render partial-failure feedback.

- [ ] **Step 1: Create the route file**

Write this exact content to `src/app/api/books/bulk/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { loadBookForWrite } from "@/lib/access";
import { getCurrentUser } from "@/lib/auth";
import { getUploadsStorage, getCoversStorage } from "@/lib/storage";
import { moveBookToCollection } from "@/lib/collections";

interface BulkBody {
  action?: string;
  ids?: unknown;
  collectionId?: string | null;
}

/**
 * Bulk operate on books. Two actions:
 *
 *   - "delete": destroy each id (cascades to chapters/paragraphs/translations)
 *   - "move":   move each id into `collectionId` (string) or to top level (null)
 *
 * Each id is processed independently — a mid-loop failure doesn't abort
 * the rest. The response `{ succeeded, failed }` lets the client report
 * partial progress and keep failed ids selected for retry.
 *
 * Authz reuses the same helpers the single-item routes use. Admin does
 * NOT gain write access to other users' books, matching single-delete.
 */
export async function POST(request: NextRequest) {
  let body: BulkBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === "string")
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids must be a non-empty string array" }, { status: 400 });
  }

  if (body.action === "delete") {
    return await doDelete(ids);
  }
  if (body.action === "move") {
    const target =
      body.collectionId === null
        ? null
        : typeof body.collectionId === "string"
          ? body.collectionId
          : undefined;
    if (target === undefined) {
      return NextResponse.json(
        { error: "collectionId must be string or null for action=move" },
        { status: 400 },
      );
    }
    return await doMove(ids, target);
  }

  return NextResponse.json({ error: "action must be 'delete' or 'move'" }, { status: 400 });
}

async function doDelete(ids: string[]) {
  const db = getDb();
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of ids) {
    try {
      const result = await loadBookForWrite(id);
      if (!result.book) {
        failed.push({ id, error: "not found" });
        continue;
      }
      if (result.forbidden) {
        failed.push({ id, error: "forbidden" });
        continue;
      }
      const { book } = result;
      await getUploadsStorage().delete(book.filePath);
      if (book.coverPath) {
        await getCoversStorage().delete(book.coverPath);
      }
      await db.delete(books).where(eq(books.id, id)).run();
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, error: (err as Error).message });
    }
  }

  return NextResponse.json({ succeeded: succeeded.length, failed });
}

async function doMove(ids: string[], targetCollectionId: string | null) {
  const user = await getCurrentUser();
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of ids) {
    try {
      await moveBookToCollection({
        bookId: id,
        targetCollectionId,
        actingUserId: user.id,
        actingIsAdmin: user.isAdmin,
      });
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, error: (err as Error).message });
    }
  }

  return NextResponse.json({ succeeded: succeeded.length, failed });
}
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification (dev server must be running)**

In a browser devtools console (signed in as an admin):

```js
await fetch("/api/books/bulk", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "delete", ids: ["does-not-exist"] }),
}).then(r => r.json());
```
Expected: `{ succeeded: 0, failed: [{ id: "does-not-exist", error: "not found" }] }`.

```js
await fetch("/api/books/bulk", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "move" }),
}).then(r => r.json());
```
Expected: `{ error: "ids must be a non-empty string array" }` with 400 status.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/books/bulk/route.ts
git commit -m "feat(api): bulk delete + bulk move endpoint for books"
```

---

### Task 4: Backend — `POST /api/collections/bulk`

**Files:**
- Create: `src/app/api/collections/bulk/route.ts`

Cascade-delete: for each collection, remove its books first (to override the schema's `ON DELETE SET NULL`), then remove the collection row.

- [ ] **Step 1: Create the route file**

Write this exact content to `src/app/api/collections/bulk/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { books, collections } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { loadOwnedCollection } from "@/lib/collections";
import { getUploadsStorage, getCoversStorage } from "@/lib/storage";

interface BulkBody {
  action?: string;
  ids?: unknown;
}

/**
 * Bulk cascade-delete collections. For each id:
 *   1. Verify the caller owns it (loadOwnedCollection — admin backdoor
 *      stays view-only and does not apply to writes).
 *   2. Delete every book whose collection_id matches. Book deletes
 *      cascade to chapters/paragraphs/translations via FK.
 *   3. Delete the collection row.
 *
 * Per-id try/catch so one bad row doesn't abort the rest. Partial
 * failure is reported via `failed[]` in the response.
 *
 * Storage cleanup (EPUB bytes + covers) mirrors the single-book delete
 * route so orphaned files don't accumulate when dropping a whole series.
 */
export async function POST(request: NextRequest) {
  let body: BulkBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === "string")
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids must be a non-empty string array" }, { status: 400 });
  }
  if (body.action !== "delete") {
    return NextResponse.json({ error: "action must be 'delete'" }, { status: 400 });
  }

  const user = await getCurrentUser();
  const db = getDb();
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of ids) {
    try {
      const owned = await loadOwnedCollection(id, {
        id: user.id,
        isAdmin: user.isAdmin,
      });
      if (!owned) {
        failed.push({ id, error: "not found or not owned" });
        continue;
      }

      const booksInside = await db
        .select({
          id: books.id,
          filePath: books.filePath,
          coverPath: books.coverPath,
        })
        .from(books)
        .where(eq(books.collectionId, id))
        .all();

      for (const b of booksInside) {
        await getUploadsStorage().delete(b.filePath);
        if (b.coverPath) {
          await getCoversStorage().delete(b.coverPath);
        }
        await db.delete(books).where(eq(books.id, b.id)).run();
      }

      await db.delete(collections).where(eq(collections.id, id)).run();
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, error: (err as Error).message });
    }
  }

  return NextResponse.json({ succeeded: succeeded.length, failed });
}
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification**

In the browser devtools console (signed in):

```js
await fetch("/api/collections/bulk", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "delete", ids: ["nonexistent-id"] }),
}).then(r => r.json());
```
Expected: `{ succeeded: 0, failed: [{ id: "nonexistent-id", error: "not found or not owned" }] }`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/collections/bulk/route.ts
git commit -m "feat(api): bulk cascade-delete endpoint for collections"
```

---

### Task 5: `BookCard` select-mode support

**Files:**
- Modify: `src/components/BookCard.tsx`

Add three optional props. When `selectMode` is true, the card intercepts the click on its cover/content area to toggle selection instead of navigating, and overlays a checkbox badge.

- [ ] **Step 1: Update the `BookCardProps` interface**

In `src/components/BookCard.tsx`, find the existing `interface BookCardProps { ... }` block and replace it with:

```ts
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
```

- [ ] **Step 2: Destructure the new props**

Find the `export function BookCard({ ... })` signature and replace the destructured arg list with:

```tsx
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
```

- [ ] **Step 3: Wrap the outer `<Card>` return in a select-aware container**

Replace the final `return ( <Card ...> ... </Card> );` block with:

```tsx
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
```

Rationale: in select mode the cover and content are made `pointer-events-none` so clicks reliably bubble up to the outer wrapper's `onClick`. The Read/Translate/⋯ buttons, the cover image, and the dropdown therefore become inert — user can only toggle selection. Dropping out of select mode restores normal behavior.

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/BookCard.tsx
git commit -m "feat(BookCard): accept select-mode props for multi-select"
```

---

### Task 6: `CollectionCard` select-mode support

**Files:**
- Modify: `src/components/CollectionCard.tsx`

Same shape as Task 5: three optional props, wraps the link with a selection-aware container, overlays a checkbox badge.

- [ ] **Step 1: Replace the file contents**

Overwrite `src/components/CollectionCard.tsx` with:

```tsx
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
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/CollectionCard.tsx
git commit -m "feat(CollectionCard): accept select-mode props for multi-select"
```

---

### Task 7: Home page — wire Library multi-select

**Files:**
- Modify: `src/app/page.tsx`

Add a `Select` toggle next to the Library section header. When active, `BookCard`s receive `selectMode`/`selected`/`onSelectToggle`; `SelectionBar` renders with Move-to and Delete actions.

- [ ] **Step 1: Add imports**

Near the top of `src/app/page.tsx`, just below the existing `Input`/`Label` imports, add:

```tsx
import { useSelection } from "@/components/library/useSelection";
import { SelectionBar } from "@/components/library/SelectionBar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
```

- [ ] **Step 2: Instantiate the book selection hook**

Inside `HomePage()`, directly below `const [importing, setImporting] = useState(false);`, add:

```tsx
  const bookSelect = useSelection();
  const collectionSelect = useSelection();
```

(The collection one is used by Task 8; adding both now keeps the hook-order stable.)

- [ ] **Step 3: Add bulk action handlers**

Inside `HomePage()`, just below `handleCreateCollection`, add:

```tsx
  const handleBulkDeleteBooks = async () => {
    const ids = Array.from(bookSelect.selected);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} ${ids.length === 1 ? "book" : "books"}? This can't be undone.`)) return;
    const res = await fetch("/api/books/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", ids }),
    });
    if (!res.ok) {
      alert(`Delete failed: ${await res.text()}`);
      return;
    }
    const data: { succeeded: number; failed: Array<{ id: string; error: string }> } = await res.json();
    if (data.failed.length > 0) {
      alert(`${data.succeeded} of ${ids.length} deleted. ${data.failed.length} failed.`);
      bookSelect.remove(ids.filter((id) => !data.failed.some((f) => f.id === id)));
    } else {
      bookSelect.exit();
    }
    fetchBooks();
    fetchCollections();
  };

  const handleBulkMoveBooks = async (collectionId: string | null) => {
    const ids = Array.from(bookSelect.selected);
    if (ids.length === 0) return;
    const res = await fetch("/api/books/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "move", ids, collectionId }),
    });
    if (!res.ok) {
      alert(`Move failed: ${await res.text()}`);
      return;
    }
    const data: { succeeded: number; failed: Array<{ id: string; error: string }> } = await res.json();
    if (data.failed.length > 0) {
      alert(`${data.succeeded} of ${ids.length} moved. ${data.failed.length} failed.`);
      bookSelect.remove(ids.filter((id) => !data.failed.some((f) => f.id === id)));
    } else {
      bookSelect.exit();
    }
    fetchBooks();
    fetchCollections();
  };
```

- [ ] **Step 4: Add the Select toggle and update the Library grid**

Find the existing Library section:

```tsx
      {books.length > 0 ? (
        <section>
          <h2
            className="text-xs uppercase tracking-[0.2em] text-muted-foreground mb-5 animate-in fade-in duration-700 delay-200"
          >
            Library
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {books.map((book, i) => (
              <div
                key={book.id}
                className="stagger-fade-in"
                style={{ animationDelay: `${250 + i * 60}ms` }}
              >
                <BookCard book={book} onDelete={handleDelete} onChange={fetchBooks} currentUserId={currentUser?.id} collections={collections} onMove={handleMove} />
              </div>
            ))}
          </div>
        </section>
      ) : (
```

Replace with:

```tsx
      {books.length > 0 ? (
        <section>
          <div className="flex items-center justify-between mb-5 animate-in fade-in duration-700 delay-200">
            <h2 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Library
            </h2>
            {!bookSelect.mode && (
              <Button
                variant="outline"
                size="sm"
                onClick={bookSelect.enter}
                className="hidden sm:inline-flex"
              >
                Select
              </Button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {books.map((book, i) => (
              <div
                key={book.id}
                className="stagger-fade-in"
                style={{ animationDelay: `${250 + i * 60}ms` }}
              >
                <BookCard
                  book={book}
                  onDelete={handleDelete}
                  onChange={fetchBooks}
                  currentUserId={currentUser?.id}
                  collections={collections}
                  onMove={handleMove}
                  selectMode={bookSelect.mode}
                  selected={bookSelect.selected.has(book.id)}
                  onSelectToggle={bookSelect.toggle}
                />
              </div>
            ))}
          </div>
        </section>
      ) : (
```

- [ ] **Step 5: Render the SelectionBar near the bottom of the JSX**

Find the existing closing `</Dialog>` just before `</div>` at the very end of the component return. Directly above `</Dialog>` insertion point, add the bar after the Dialog closes but before the outermost `</div>`. Concretely, replace:

```tsx
      </Dialog>
    </div>
  );
}
```

with:

```tsx
      </Dialog>

      {bookSelect.mode && (
        <SelectionBar
          count={bookSelect.selected.size}
          total={books.length}
          noun="book"
          onSelectAll={() => bookSelect.selectAll(books.map((b) => b.id))}
          onClear={bookSelect.clear}
          onDone={bookSelect.exit}
        >
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bookSelect.selected.size === 0}
                >
                  Move to…
                </Button>
              }
            />
            <DropdownMenuContent align="center">
              <DropdownMenuItem onClick={() => handleBulkMoveBooks(null)}>
                Top level
              </DropdownMenuItem>
              {collections.map((c) => (
                <DropdownMenuItem key={c.id} onClick={() => handleBulkMoveBooks(c.id)}>
                  {c.name}
                </DropdownMenuItem>
              ))}
              {collections.length === 0 && (
                <DropdownMenuItem disabled>No collections</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            disabled={bookSelect.selected.size === 0}
            onClick={handleBulkDeleteBooks}
            className="text-destructive hover:bg-destructive/10 hover:border-destructive/40"
          >
            Delete
          </Button>
        </SelectionBar>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Manual verification**

With the dev server running:
1. Go to `/`.
2. Click `Select` next to the Library header. Each book card should show an empty checkbox badge.
3. Click two cards — ring + filled check appear; count in the bar reads "2 books selected".
4. Click `Move to…` → pick a collection → both books leave Library and appear inside that collection.
5. Re-enter select mode, select 1 book, click `Delete`, confirm → book vanishes.
6. Re-enter select mode, press `Esc` → mode exits and selection clears.

- [ ] **Step 8: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat(home): Library multi-select with bulk move/delete"
```

---

### Task 8: Home page — wire Collections multi-select

**Files:**
- Modify: `src/app/page.tsx` (continues from Task 7)

The `collectionSelect` hook is already instantiated from Task 7. This task adds its UI.

- [ ] **Step 1: Add the bulk-delete handler for collections**

Inside `HomePage()`, below `handleBulkMoveBooks`, add:

```tsx
  const handleBulkDeleteCollections = async () => {
    const ids = Array.from(collectionSelect.selected);
    if (ids.length === 0) return;
    const totalBooks = collections
      .filter((c) => collectionSelect.selected.has(c.id))
      .reduce((n, c) => n + c.bookCount, 0);
    const msg =
      totalBooks > 0
        ? `Delete ${ids.length} ${ids.length === 1 ? "collection" : "collections"} and all ${totalBooks} ${totalBooks === 1 ? "book" : "books"} inside them? This can't be undone.`
        : `Delete ${ids.length} ${ids.length === 1 ? "collection" : "collections"}? This can't be undone.`;
    if (!confirm(msg)) return;
    const res = await fetch("/api/collections/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", ids }),
    });
    if (!res.ok) {
      alert(`Delete failed: ${await res.text()}`);
      return;
    }
    const data: { succeeded: number; failed: Array<{ id: string; error: string }> } = await res.json();
    if (data.failed.length > 0) {
      alert(`${data.succeeded} of ${ids.length} deleted. ${data.failed.length} failed.`);
      collectionSelect.remove(ids.filter((id) => !data.failed.some((f) => f.id === id)));
    } else {
      collectionSelect.exit();
    }
    fetchBooks();
    fetchCollections();
  };
```

- [ ] **Step 2: Update the Collections header and grid**

Find the existing Collections section:

```tsx
      <section className="mb-10">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Collections
          </h2>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCreateOpen(true)}
          >
            + New collection
          </Button>
        </div>
```

Replace with:

```tsx
      <section className="mb-10">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Collections
          </h2>
          <div className="flex items-center gap-2">
            {!collectionSelect.mode && collections.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={collectionSelect.enter}
                className="hidden sm:inline-flex"
              >
                Select
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreateOpen(true)}
            >
              + New collection
            </Button>
          </div>
        </div>
```

Then find the inner `<CollectionCard ... />` call and replace it with:

```tsx
                <CollectionCard
                  collection={c}
                  currentUserId={currentUser?.id}
                  isAdmin={isAdmin}
                  selectMode={collectionSelect.mode}
                  selected={collectionSelect.selected.has(c.id)}
                  onSelectToggle={collectionSelect.toggle}
                />
```

- [ ] **Step 3: Render the collections SelectionBar**

Directly after the `bookSelect.mode && (...)` SelectionBar block from Task 7, add a second bar:

```tsx
      {collectionSelect.mode && (
        <SelectionBar
          count={collectionSelect.selected.size}
          total={collections.length}
          noun="collection"
          onSelectAll={() => collectionSelect.selectAll(collections.map((c) => c.id))}
          onClear={collectionSelect.clear}
          onDone={collectionSelect.exit}
        >
          <Button
            variant="outline"
            size="sm"
            disabled={collectionSelect.selected.size === 0}
            onClick={handleBulkDeleteCollections}
            className="text-destructive hover:bg-destructive/10 hover:border-destructive/40"
          >
            Delete
          </Button>
        </SelectionBar>
      )}
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual verification**

1. Create two collections (each with at least one book inside for the cascade).
2. Go to `/`, click `Select` next to the Collections header.
3. Select both collections. Bar reads "2 collections selected".
4. Click `Delete`. Confirm dialog mentions both collections AND the total book count.
5. Confirm → both collections gone, all contained books gone from Library.

- [ ] **Step 6: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat(home): Collections multi-select with cascade delete"
```

---

### Task 9: Collection detail page — books multi-select

**Files:**
- Modify: `src/app/collections/[id]/page.tsx`

The collection detail page today renders books as inline `<li>` rows, not `<BookCard>`. The multi-select there is implemented directly on the `<li>` wrapper so we don't change the existing row layout.

- [ ] **Step 1: Add imports**

Near the top of `src/app/collections/[id]/page.tsx`, add:

```tsx
import { useSelection } from "@/components/library/useSelection";
import { SelectionBar } from "@/components/library/SelectionBar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
```

- [ ] **Step 2: Add a collections-list state and fetch**

Inside `CollectionPage()`, directly below `const [busyId, setBusyId] = useState<string | null>(null);`, add:

```tsx
  const [allCollections, setAllCollections] = useState<Array<{ id: string; name: string }>>([]);
  const bookSelect = useSelection();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/collections")
      .then((res) => (res.ok ? res.json() : []))
      .then((data: Array<{ id: string; name: string }>) => {
        if (!cancelled) setAllCollections(data ?? []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
```

- [ ] **Step 3: Add bulk handlers**

Inside `CollectionPage()`, below `handleDeleteCollection`, add:

```tsx
  const handleBulkMoveBooks = async (collectionId: string | null) => {
    const ids = Array.from(bookSelect.selected);
    if (ids.length === 0) return;
    const res = await fetch("/api/books/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "move", ids, collectionId }),
    });
    if (!res.ok) {
      alert(`Move failed: ${await res.text()}`);
      return;
    }
    const data: { succeeded: number; failed: Array<{ id: string; error: string }> } = await res.json();
    if (data.failed.length > 0) {
      alert(`${data.succeeded} of ${ids.length} moved. ${data.failed.length} failed.`);
      bookSelect.remove(ids.filter((id) => !data.failed.some((f) => f.id === id)));
    } else {
      bookSelect.exit();
    }
    fetchCollection();
  };

  const handleBulkDeleteBooks = async () => {
    const ids = Array.from(bookSelect.selected);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} ${ids.length === 1 ? "book" : "books"}? This can't be undone.`)) return;
    const res = await fetch("/api/books/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", ids }),
    });
    if (!res.ok) {
      alert(`Delete failed: ${await res.text()}`);
      return;
    }
    const data: { succeeded: number; failed: Array<{ id: string; error: string }> } = await res.json();
    if (data.failed.length > 0) {
      alert(`${data.succeeded} of ${ids.length} deleted. ${data.failed.length} failed.`);
      bookSelect.remove(ids.filter((id) => !data.failed.some((f) => f.id === id)));
    } else {
      bookSelect.exit();
    }
    fetchCollection();
  };
```

- [ ] **Step 4: Add a Select toggle to the "Books in this series" header**

Find:

```tsx
      <div className="mb-5">
        <h2 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Books in this series
        </h2>
      </div>
```

Replace with:

```tsx
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Books in this series
        </h2>
        {!readOnly && !bookSelect.mode && collection.books.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={bookSelect.enter}
            className="hidden sm:inline-flex"
          >
            Select
          </Button>
        )}
      </div>
```

- [ ] **Step 5: Wrap the book `<li>` rows with select behavior**

Find the existing `<li key={book.id} ...>` element and replace the opening tag and its inner layout so that in select mode the entire row becomes a toggle target. Specifically, replace:

```tsx
          {collection.books.map((book, i) => (
            <li
              key={book.id}
              className="flex items-center gap-4 p-3 rounded-xl border border-border/50 hover:border-primary/30 hover:bg-accent/20 transition-all"
            >
              <div className="text-sm tabular-nums text-muted-foreground w-6 text-center">
                {i + 1}
              </div>
```

with:

```tsx
          {collection.books.map((book, i) => {
            const isSel = bookSelect.selected.has(book.id);
            return (
            <li
              key={book.id}
              className={`flex items-center gap-4 p-3 rounded-xl border transition-all ${
                bookSelect.mode
                  ? `cursor-pointer ${isSel ? "border-primary ring-2 ring-primary ring-offset-2 bg-accent/30" : "border-border/50 hover:border-primary/30 hover:bg-accent/20"}`
                  : "border-border/50 hover:border-primary/30 hover:bg-accent/20"
              }`}
              onClick={
                bookSelect.mode
                  ? (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      bookSelect.toggle(book.id);
                    }
                  : undefined
              }
            >
              {bookSelect.mode && (
                <div
                  className={`h-5 w-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                    isSel ? "bg-primary border-primary text-primary-foreground" : "bg-background/90 border-border/80"
                  }`}
                  aria-hidden
                >
                  {isSel && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </div>
              )}
              <div className="text-sm tabular-nums text-muted-foreground w-6 text-center">
                {i + 1}
              </div>
```

And add a closing `);}` after the existing closing `</li>` — find:

```tsx
            </li>
          ))}
```

Replace with:

```tsx
            </li>
            );
          })}
```

- [ ] **Step 6: Suppress inner link + button clicks while in select mode**

Still inside the `<li>` body, find the `<Link href={`/read/${book.id}`} ...>` and the `<div className="flex items-center gap-1">` (the row-action buttons). Wrap them so that in select mode their clicks don't fire. Concretely, replace:

```tsx
              <div className="flex-1 min-w-0">
                <Link
                  href={`/read/${book.id}`}
                  className="font-medium hover:text-primary transition-colors truncate block"
                  style={{ fontFamily: "var(--font-heading)" }}
                >
                  {book.title}
                </Link>
                <p className="text-xs text-muted-foreground truncate">
                  {book.author} · {LANG_LABELS[book.sourceLang] ?? book.sourceLang} · {book.translatedChapters}/{book.totalChapters}
                </p>
              </div>
              {!readOnly && (
                <div className="flex items-center gap-1">
```

with:

```tsx
              <div className={`flex-1 min-w-0 ${bookSelect.mode ? "pointer-events-none" : ""}`}>
                <Link
                  href={`/read/${book.id}`}
                  className="font-medium hover:text-primary transition-colors truncate block"
                  style={{ fontFamily: "var(--font-heading)" }}
                >
                  {book.title}
                </Link>
                <p className="text-xs text-muted-foreground truncate">
                  {book.author} · {LANG_LABELS[book.sourceLang] ?? book.sourceLang} · {book.translatedChapters}/{book.totalChapters}
                </p>
              </div>
              {!readOnly && !bookSelect.mode && (
                <div className="flex items-center gap-1">
```

- [ ] **Step 7: Render the SelectionBar at the end of the JSX**

Find the existing closing `</Dialog>` block near the end of the return. Replace:

```tsx
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename collection</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRename} disabled={!renameValue.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

with:

```tsx
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename collection</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRename} disabled={!renameValue.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {bookSelect.mode && (
        <SelectionBar
          count={bookSelect.selected.size}
          total={collection.books.length}
          noun="book"
          onSelectAll={() => bookSelect.selectAll(collection.books.map((b) => b.id))}
          onClear={bookSelect.clear}
          onDone={bookSelect.exit}
        >
          <Button
            variant="outline"
            size="sm"
            disabled={bookSelect.selected.size === 0}
            onClick={() => handleBulkMoveBooks(null)}
          >
            Move out
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bookSelect.selected.size === 0}
                >
                  Move to…
                </Button>
              }
            />
            <DropdownMenuContent align="center">
              {allCollections.filter((c) => c.id !== id).length === 0 ? (
                <DropdownMenuItem disabled>No other collections</DropdownMenuItem>
              ) : (
                allCollections
                  .filter((c) => c.id !== id)
                  .map((c) => (
                    <DropdownMenuItem key={c.id} onClick={() => handleBulkMoveBooks(c.id)}>
                      {c.name}
                    </DropdownMenuItem>
                  ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            disabled={bookSelect.selected.size === 0}
            onClick={handleBulkDeleteBooks}
            className="text-destructive hover:bg-destructive/10 hover:border-destructive/40"
          >
            Delete
          </Button>
        </SelectionBar>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Manual verification**

1. Open a collection that has at least 3 books and at least one other collection exists.
2. Click `Select` next to "Books in this series". Each row shows a checkbox.
3. Select 2 books.
4. Click `Move out` → both books return to top-level, row count drops by 2.
5. Re-enter select mode, select another book, click `Move to…` → choose another collection → book moves across, disappears from current view.
6. Re-enter select mode, select the last book, click `Delete`, confirm → book gone.
7. Verify `Esc` exits mode.

- [ ] **Step 10: Commit**

```bash
git add src/app/collections/[id]/page.tsx
git commit -m "feat(collection): multi-select for books inside a collection"
```

---

## Post-plan verification

After Task 9:

1. Run `npx tsc --noEmit` — zero errors.
2. Run `npm run lint` (if the project has one wired) — zero new warnings.
3. Walk the full spec smoke list (Section "Testing" of the spec) once against the running dev server.
4. Push the branch: `git push origin master`.
