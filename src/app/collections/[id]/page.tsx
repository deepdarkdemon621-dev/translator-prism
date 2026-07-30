"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { SortableGridItem, useLibraryDndSensors } from "@/components/library/dnd";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { translateAllWithGate } from "@/lib/translate/client";
import { useSelection } from "@/components/library/useSelection";
import { SelectionBar } from "@/components/library/SelectionBar";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface CollectionBook {
  id: string;
  title: string;
  author: string;
  sourceLang: string;
  coverPath: string | null;
  totalChapters: number;
  translatedChapters: number;
  pendingTranslations: number;
  status: string;
  seq: number | null;
}

interface CollectionDetail {
  id: string;
  name: string;
  userId: string;
  visibility: "public" | "private";
  isReadOnly: boolean;
  createdAt: string;
  updatedAt: string;
  books: CollectionBook[];
}

const LANG_LABELS: Record<string, string> = {
  ja: "日本語",
  zh: "中文",
  en: "English",
};

export default function CollectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [collection, setCollection] = useState<CollectionDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [allCollections, setAllCollections] = useState<Array<{ id: string; name: string }>>([]);
  const [allCollectionsLoaded, setAllCollectionsLoaded] = useState(false);
  const bookSelect = useSelection();
  const confirm = useConfirm();
  const dndSensors = useLibraryDndSensors();

  const fetchAllCollections = useCallback(async () => {
    if (allCollectionsLoaded) return;
    const res = await fetch("/api/collections");
    if (!res.ok) return;
    const data: Array<{ id: string; name: string }> = await res.json();
    setAllCollections(data ?? []);
    setAllCollectionsLoaded(true);
  }, [allCollectionsLoaded]);

  const fetchCollection = useCallback(async () => {
    const res = await fetch(`/api/collections/${id}`);
    if (res.ok) {
      const data: CollectionDetail = await res.json();
      setCollection(data);
      setRenameValue(data.name);
    } else if (res.status === 404) {
      setNotFound(true);
    }
  }, [id]);

  useEffect(() => {
    fetchCollection();
  }, [fetchCollection]);

  useEffect(() => {
    if (notFound) router.replace("/");
  }, [notFound, router]);

  const handleTranslate = async (bookId: string) => {
    setBusyId(bookId);
    try {
      const res = await translateAllWithGate(`/api/books/${bookId}/translate-all`);
      if (res.cancelled) return;
      if (res.error) {
        alert(`Translate failed: ${res.error}`);
        return;
      }
      if (res.queued > 0) {
        alert(`Queued ${res.queued} translations${res.chaptersQueued ? ` across ${res.chaptersQueued} chapters` : ""}.`);
        fetchCollection();
      } else {
        alert("Nothing to translate — everything looks done.");
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleCancelTranslate = async (book: CollectionBook) => {
    if (!(await confirm({
      title: `Cancel ${book.pendingTranslations} pending translation(s)?`,
      description: "In-flight calls can't be stopped but their results will be discarded.",
      confirmText: "Cancel translations",
      cancelText: "Keep running",
      destructive: true,
    }))) return;
    setBusyId(book.id);
    try {
      const res = await fetch(`/api/books/${book.id}/translate-cancel`, { method: "POST" });
      if (!res.ok) {
        alert(`Cancel failed: ${await res.text()}`);
        return;
      }
      const data = await res.json();
      alert(`Cancelled ${data.cancelled} translation(s).`);
      fetchCollection();
    } finally {
      setBusyId(null);
    }
  };

  const handleMoveOut = async (bookId: string) => {
    const res = await fetch(`/api/books/${bookId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collectionId: null }),
    });
    if (res.ok) {
      // Drop the row locally instead of reloading the whole detail view.
      setCollection((prev) =>
        prev ? { ...prev, books: prev.books.filter((b) => b.id !== bookId) } : prev,
      );
    }
  };

  const moveBy = async (bookId: string, delta: -1 | 1) => {
    if (!collection) return;
    const idx = collection.books.findIndex((b) => b.id === bookId);
    const newIdx = idx + delta;
    if (idx < 0 || newIdx < 0 || newIdx >= collection.books.length) return;
    const next = [...collection.books];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    setCollection({ ...collection, books: next });
    const res = await fetch(`/api/collections/${id}/books`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: next.map((b) => b.id) }),
    }).catch(() => null);
    // The optimistic swap already matches the server result; only a
    // failure needs the authoritative refetch.
    if (!res?.ok) fetchCollection();
  };

  // Drag-and-drop reorder within the collection. Optimistic local update
  // through the same PUT order API the arrow buttons use; a failure
  // reverts via refetch.
  const handleDragEnd = async (event: DragEndEvent) => {
    if (!collection) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = collection.books.findIndex((b) => b.id === active.id);
    const newIndex = collection.books.findIndex((b) => b.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(collection.books, oldIndex, newIndex);
    setCollection({ ...collection, books: next });
    const res = await fetch(`/api/collections/${id}/books`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: next.map((b) => b.id) }),
    }).catch(() => null);
    if (!res?.ok) {
      alert("Reorder failed");
      fetchCollection();
    }
  };

  const handleEnterBookSelect = () => {
    bookSelect.enter();
    fetchAllCollections();
  };

  const handleRename = async () => {
    const name = renameValue.trim();
    if (!name) return;
    const res = await fetch(`/api/collections/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      setRenameOpen(false);
      fetchCollection();
    }
  };

  const handleDeleteCollection = async () => {
    if (!(await confirm({
      title: "Delete this collection?",
      description: "The books themselves will stay in your library.",
      confirmText: "Delete",
      destructive: true,
    }))) return;
    const res = await fetch(`/api/collections/${id}`, { method: "DELETE" });
    if (res.ok) router.push("/");
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
    fetchCollection();
  };

  const handleBulkDeleteBooks = async () => {
    const ids = Array.from(bookSelect.selected);
    if (ids.length === 0) return;
    if (!(await confirm({
      title: `Delete ${ids.length} ${ids.length === 1 ? "book" : "books"}?`,
      description: "This can't be undone. Translations and files will be removed.",
      confirmText: "Delete",
      destructive: true,
    }))) return;
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

  if (notFound) return null;
  if (!collection) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground italic">
        Loading…
      </div>
    );
  }

  const readOnly = collection.isReadOnly;

  return (
    <div className="min-h-screen px-6 py-10 sm:py-14 max-w-5xl mx-auto">
      <header className="mb-10 flex items-center gap-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
        <Link
          href="/"
          className="h-10 w-10 flex items-center justify-center rounded-full border border-border/60 text-foreground hover:bg-accent/60 hover:border-primary/40 hover:-translate-x-0.5 transition-all duration-200"
          aria-label="Back to library"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
        </Link>
        <div className="flex-1 min-w-0">
          <h1
            className="text-3xl font-medium tracking-tight truncate"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            {collection.name}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {collection.books.length} {collection.books.length === 1 ? "book" : "books"}
            {collection.books.length > 0 && (
              <>
                {" · Cover: "}
                <span className="italic">{collection.books[0].title}</span>
              </>
            )}
          </p>
        </div>
        {!readOnly && (
          <>
            <Button variant="outline" size="sm" onClick={() => setRenameOpen(true)}>
              Rename
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground hover:text-destructive hover:border-destructive/40"
              onClick={handleDeleteCollection}
            >
              Delete
            </Button>
          </>
        )}
      </header>

      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Books in this series
        </h2>
        {!readOnly && !bookSelect.mode && collection.books.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleEnterBookSelect}
            className="hidden sm:inline-flex"
          >
            Select
          </Button>
        )}
      </div>

      {collection.books.length === 0 ? (
        <Card className="border-dashed border-border/50 py-12 text-center">
          <p className="text-muted-foreground italic" style={{ fontFamily: "var(--font-heading)" }}>
            This collection is empty.
          </p>
          <p className="text-sm text-muted-foreground/70 mt-1">
            Upload a book with this collection selected, or move an existing book in from the library.
          </p>
        </Card>
      ) : (
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
        <SortableContext
          items={collection.books.map((b) => b.id)}
          strategy={verticalListSortingStrategy}
        >
        <ol className="space-y-3">
          {collection.books.map((book, i) => {
            const isSel = bookSelect.selected.has(book.id);
            return (
            <SortableGridItem
              as="li"
              key={book.id}
              id={book.id}
              type="book"
              disabled={bookSelect.mode || readOnly}
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
              <div className="relative h-16 w-12 overflow-hidden rounded bg-muted/40 shrink-0">
                {book.coverPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/books/${book.id}/cover`}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : (
                  <div
                    className="absolute inset-0 flex items-center justify-center text-lg text-muted-foreground/50"
                    style={{ fontFamily: "var(--font-heading)" }}
                  >
                    {book.title.charAt(0)}
                  </div>
                )}
              </div>
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
              {!bookSelect.mode && (
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    className="h-7 text-xs px-3"
                    nativeButton={false}
                    render={<Link href={`/read/${book.id}`}>Read</Link>}
                  />
                  {!readOnly && (
                    <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={i === 0}
                    onClick={() => moveBy(book.id, -1)}
                    aria-label="Move up"
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={i === collection.books.length - 1}
                    onClick={() => moveBy(book.id, 1)}
                    aria-label="Move down"
                  >
                    ↓
                  </Button>
                  {book.translatedChapters < book.totalChapters && (
                    book.pendingTranslations > 0 ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCancelTranslate(book)}
                        disabled={busyId === book.id}
                        className="h-7 text-xs px-2 text-destructive hover:bg-destructive/10 hover:border-destructive/40"
                      >
                        {busyId === book.id ? "…" : `Cancel (${book.pendingTranslations})`}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleTranslate(book.id)}
                        disabled={busyId === book.id}
                        className="h-7 text-xs px-2"
                      >
                        {busyId === book.id ? "…" : "Translate"}
                      </Button>
                    )
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => handleMoveOut(book.id)}
                  >
                    Move out
                  </Button>
                    </>
                  )}
                </div>
              )}
            </SortableGridItem>
            );
          })}
        </ol>
        </SortableContext>
        </DndContext>
      )}

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
