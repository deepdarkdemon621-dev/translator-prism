"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { UploadZone } from "@/components/UploadZone";
import { BookCard } from "@/components/BookCard";
import { CollectionCard } from "@/components/CollectionCard";
import { CreditsBadge } from "@/components/CreditsBadge";
import { Button } from "@/components/ui/button";
import { translateAllWithGate } from "@/lib/translate/client";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSelection } from "@/components/library/useSelection";
import { SelectionBar } from "@/components/library/SelectionBar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Book {
  id: string;
  title: string;
  author: string;
  sourceLang: string;
  totalChapters: number;
  translatedChapters: number;
  status: string;
  coverPath?: string | null;
  pendingTranslations?: number;
  userId?: string | null;
  collectionId?: string | null;
}

interface Collection {
  id: string;
  name: string;
  bookCount: number;
  coverBookId: string | null;
  coverPath: string | null;
  userId?: string;
  visibility?: "public" | "private";
}

export default function HomePage() {
  const [books, setBooks] = useState<Book[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [currentUser, setCurrentUser] = useState<{ id: string; isAdmin: boolean } | null>(null);
  const isAdmin = currentUser?.isAdmin ?? false;
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [cancellingAll, setCancellingAll] = useState(false);
  const [importing, setImporting] = useState(false);
  const bookSelect = useSelection();
  const collectionSelect = useSelection();

  const fetchBooks = useCallback(async () => {
    const res = await fetch("/api/books?scope=top");
    if (res.ok) setBooks(await res.json());
  }, []);

  const fetchCollections = useCallback(async () => {
    const res = await fetch("/api/collections");
    if (res.ok) {
      setCollections(await res.json());
    }
  }, []);

  useEffect(() => {
    fetchBooks();
    fetchCollections();
  }, [fetchBooks, fetchCollections]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/user")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { id?: string; isAdmin?: boolean } | null) => {
        if (!cancelled && data?.id) {
          setCurrentUser({ id: data.id, isAdmin: !!data.isAdmin });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/books/${id}`, { method: "DELETE" });
    if (res.ok) {
      fetchBooks();
      // Deleting a book cascades to membership rows; refresh the
      // collection covers + counts so the shelf reflects reality.
      fetchCollections();
    }
  };

  const handleMove = async (bookId: string, collectionId: string | null) => {
    const res = await fetch(`/api/books/${bookId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collectionId }),
    });
    if (res.ok) {
      fetchBooks();
      fetchCollections();
    } else {
      alert(`Move failed: ${await res.text()}`);
    }
  };

  // Admin-only: library-wide sweep. Same cost-gate flow as the per-book
  // button, just pointed at the sweep endpoint. Refreshes the list so
  // chapter counts move toward "done" as jobs finish in the background.
  const handleTranslateAllLibrary = async () => {
    setSweeping(true);
    try {
      const res = await translateAllWithGate("/api/books/translate-all");
      if (res.cancelled) return;
      if (res.error) {
        alert(`Translate failed: ${res.error}`);
        return;
      }
      if (res.queued > 0) {
        alert(`Queued ${res.queued} translations across ${res.chaptersQueued ?? 0} chapters.`);
        fetchBooks();
      } else {
        alert("Nothing to queue — every chapter already done or in flight.");
      }
    } finally {
      setSweeping(false);
    }
  };

  // Admin-only: cancel every pending translation across the admin's
  // library. In-flight provider calls will still resolve server-side, but
  // their results are dropped by the queue's status guard — no tokens
  // burn after this point for queued-but-not-started jobs.
  const handleCancelAll = async () => {
    const anyPending = books.some((b) => (b.pendingTranslations ?? 0) > 0);
    if (!anyPending) {
      alert("Nothing to cancel — no pending translations.");
      return;
    }
    if (!confirm("Cancel every pending translation across your whole library?")) return;
    setCancellingAll(true);
    try {
      const res = await fetch("/api/books/translate-cancel-all", { method: "POST" });
      if (!res.ok) {
        alert(`Cancel failed: ${await res.text()}`);
        return;
      }
      const data = await res.json();
      alert(`Cancelled ${data.cancelled} translation(s) across ${data.booksTouched} book(s).`);
      fetchBooks();
    } finally {
      setCancellingAll(false);
    }
  };

  // Admin-only: upload a previously-exported Prism JSON. Distinct from
  // the EPUB upload flow because imports come pre-translated.
  const handleImport = async (file: File) => {
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/books/import", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const text = await res.text();
        alert(`Import failed: ${text}`);
        return;
      }
      const data = await res.json();
      alert(`Imported "${data.title}" — ${data.chapters} chapters, ${data.translations} translations.`);
      fetchBooks();
    } finally {
      setImporting(false);
    }
  };

  const handleCreateCollection = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const res = await fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        setNewName("");
        setCreateOpen(false);
        fetchCollections();
      }
    } finally {
      setCreating(false);
    }
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

  return (
    <div className="min-h-screen px-6 py-10 sm:py-14 max-w-6xl mx-auto">
      <header className="mb-12 flex items-start justify-between gap-6">
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-700">
          <h1
            className="text-4xl sm:text-5xl font-medium tracking-tight"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            Prism
          </h1>
          <p
            className="mt-2 text-muted-foreground text-base italic"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            One book, many languages.
          </p>
        </div>
        <nav className="flex items-center gap-1 text-sm animate-in fade-in duration-700 delay-100">
          <CreditsBadge />
          {/* Account menu — sign-out lives here. Clerk 7 drops the
              `afterSignOutUrl` prop; sign-out flows through middleware. */}
          <UserButton />
          {isAdmin && (
            <>
              {/* Library-wide batch translate. Goes through the cost gate
                  for paid providers; free-fires for Ollama. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleTranslateAllLibrary}
                disabled={sweeping}
                title="Queue every non-done chapter across all your books"
              >
                {sweeping ? "Queueing…" : "Translate all"}
              </Button>
              {/* Library-wide cancel. Hidden unless there's something
                  pending — keeps the nav uncluttered when nothing's in
                  flight. */}
              {books.some((b) => (b.pendingTranslations ?? 0) > 0) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCancelAll}
                  disabled={cancellingAll}
                  title="Cancel every pending translation across your library"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  {cancellingAll ? "Cancelling…" : "Cancel all"}
                </Button>
              )}
              {/* Hidden file input so we don't need a separate route for the
                  import trigger. The Prism JSON export is selected here and
                  POSTed straight to /api/books/import. */}
              <label className="inline-flex cursor-pointer">
                <span className="px-3 py-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors select-none">
                  {importing ? "Importing…" : "Import"}
                </span>
                <input
                  type="file"
                  accept=".json,.prism.json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleImport(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </>
          )}
          {[
            // Dictionaries: admin-only (install/manage surface). Lookup
            // stays open for all users inside the reader popover.
            { href: "/dictionary", label: "Dictionaries", adminOnly: true },
            { href: "/vocabulary", label: "Vocabulary", adminOnly: false },
            { href: "/settings", label: "Settings", adminOnly: false },
          ]
            .filter((item) => !item.adminOnly || isAdmin)
            .map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="px-3 py-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
              >
                {item.label}
              </Link>
            ))}
        </nav>
      </header>

      <section className="mb-12 animate-in fade-in slide-in-from-bottom-3 duration-700 delay-150">
        <UploadZone onUploadComplete={fetchBooks} />
      </section>

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
        {collections.length === 0 ? (
          <p className="text-sm text-muted-foreground italic"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            Group books into a series — the first book's cover becomes the shelf.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5">
            {collections.map((c, i) => (
              <div
                key={c.id}
                className="stagger-fade-in"
                style={{ animationDelay: `${200 + i * 60}ms` }}
              >
                <CollectionCard
                  collection={c}
                  currentUserId={currentUser?.id}
                  isAdmin={isAdmin}
                  selectMode={collectionSelect.mode}
                  selected={collectionSelect.selected.has(c.id)}
                  onSelectToggle={collectionSelect.toggle}
                />
              </div>
            ))}
          </div>
        )}
      </section>

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
        <div className="text-center py-16 animate-in fade-in duration-700 delay-200">
          <p
            className="text-muted-foreground italic text-lg"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            Your library is empty.
          </p>
          <p className="text-muted-foreground/70 text-sm mt-1">
            Upload an EPUB above to begin.
          </p>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New collection</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="collection-name">Name</Label>
            <Input
              id="collection-name"
              placeholder="e.g. からかい上手の高木さん"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateCollection();
              }}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              You can add books after creating the collection.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateCollection}
              disabled={creating || !newName.trim()}
            >
              {creating ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
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
    </div>
  );
}
