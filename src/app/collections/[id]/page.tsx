"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

interface CollectionBook {
  id: string;
  title: string;
  author: string;
  sourceLang: string;
  coverPath: string | null;
  totalChapters: number;
  translatedChapters: number;
  status: string;
  seq: number;
}

interface CollectionDetail {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  books: CollectionBook[];
}

interface LibraryBook {
  id: string;
  title: string;
  author: string;
  coverPath?: string | null;
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
  const [library, setLibrary] = useState<LibraryBook[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");

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

  const fetchLibrary = useCallback(async () => {
    const res = await fetch("/api/books");
    if (res.ok) setLibrary(await res.json());
  }, []);

  useEffect(() => {
    fetchCollection();
    fetchLibrary();
  }, [fetchCollection, fetchLibrary]);

  useEffect(() => {
    if (notFound) router.replace("/");
  }, [notFound, router]);

  const handleAdd = async (bookId: string) => {
    const res = await fetch(`/api/collections/${id}/books`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId }),
    });
    if (res.ok) fetchCollection();
  };

  const handleRemove = async (bookId: string) => {
    const res = await fetch(`/api/collections/${id}/books/${bookId}`, {
      method: "DELETE",
    });
    if (res.ok) fetchCollection();
  };

  const moveBy = async (bookId: string, delta: -1 | 1) => {
    if (!collection) return;
    const idx = collection.books.findIndex((b) => b.id === bookId);
    const newIdx = idx + delta;
    if (idx < 0 || newIdx < 0 || newIdx >= collection.books.length) return;
    const next = [...collection.books];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    // Optimistic update so the cover changes immediately.
    setCollection({ ...collection, books: next });
    await fetch(`/api/collections/${id}/books`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: next.map((b) => b.id) }),
    });
    fetchCollection();
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
    if (!confirm("Delete this collection? The books themselves will stay in your library.")) {
      return;
    }
    const res = await fetch(`/api/collections/${id}`, { method: "DELETE" });
    if (res.ok) router.push("/");
  };

  if (notFound) return null;
  if (!collection) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground italic">
        Loading…
      </div>
    );
  }

  // Books not already in the collection — offered in the "Add book" dialog.
  const memberIds = new Set(collection.books.map((b) => b.id));
  const addable = library.filter((b) => !memberIds.has(b.id));

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
      </header>

      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Books in this series
        </h2>
        <Button
          size="sm"
          disabled={addable.length === 0}
          onClick={() => setAddOpen(true)}
        >
          + Add book
        </Button>
      </div>

      {collection.books.length === 0 ? (
        <Card className="border-dashed border-border/50 py-12 text-center">
          <p className="text-muted-foreground italic" style={{ fontFamily: "var(--font-heading)" }}>
            This collection is empty.
          </p>
          <p className="text-sm text-muted-foreground/70 mt-1">
            Click &quot;Add book&quot; to bring a book from your library.
          </p>
        </Card>
      ) : (
        <ol className="space-y-3">
          {collection.books.map((book, i) => (
            <li
              key={book.id}
              className="flex items-center gap-4 p-3 rounded-xl border border-border/50 hover:border-primary/30 hover:bg-accent/20 transition-all"
            >
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
              <div className="flex items-center gap-1">
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
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => handleRemove(book.id)}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {/* Add book picker. Only shows library books not already in this
          collection; clicking a row appends it to the tail so the cover
          doesn't move unexpectedly. */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add book</DialogTitle>
          </DialogHeader>
          {addable.length === 0 ? (
            <p className="text-sm text-muted-foreground italic py-6 text-center">
              Every book in your library is already in this collection.
            </p>
          ) : (
            <div className="max-h-[50vh] overflow-y-auto space-y-1.5">
              {addable.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-accent/60 transition-colors text-left"
                  onClick={() => {
                    handleAdd(b.id);
                    // Close only if this was the last addable book;
                    // otherwise keep open so user can add multiple.
                    if (addable.length === 1) setAddOpen(false);
                  }}
                >
                  <div className="relative h-12 w-9 overflow-hidden rounded bg-muted/40 shrink-0">
                    {b.coverPath ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/books/${b.id}/cover`}
                        alt=""
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    ) : (
                      <div
                        className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground/50"
                        style={{ fontFamily: "var(--font-heading)" }}
                      >
                        {b.title.charAt(0)}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{b.title}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {b.author}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
