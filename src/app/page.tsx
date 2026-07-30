"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { Menu } from "lucide-react";
import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, rectSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import { SortableGridItem, useLibraryDndSensors } from "@/components/library/dnd";
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
import { useToast } from "@/components/ui/toast";
import { useSelection } from "@/components/library/useSelection";
import { SelectionBar } from "@/components/library/SelectionBar";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const bookSelect = useSelection();
  const collectionSelect = useSelection();
  const confirm = useConfirm();
  const toast = useToast();
  const dndSensors = useLibraryDndSensors();

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
      // Top-level books aren't collection members, so only the book list
      // changes — no need to reload both endpoints from Turso.
      setBooks((prev) => prev.filter((b) => b.id !== id));
    }
  };

  const handleMove = async (bookId: string, collectionId: string | null) => {
    const res = await fetch(`/api/books/${bookId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collectionId }),
    });
    if (res.ok) {
      if (collectionId) {
        setBooks((prev) => prev.filter((b) => b.id !== bookId));
        setCollections((prev) =>
          prev.map((c) =>
            c.id === collectionId ? { ...c, bookCount: c.bookCount + 1 } : c,
          ),
        );
        // Cover can change when the collection was empty; refresh quietly.
        fetchCollections();
      }
    } else {
      toast(`Move failed: ${await res.text()}`, { variant: "error" });
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
        toast(`Translate failed: ${res.error}`, { variant: "error" });
        return;
      }
      if (res.queued > 0) {
        toast(`Queued ${res.queued} translations across ${res.chaptersQueued ?? 0} chapters.`, { variant: "success" });
        fetchBooks();
      } else {
        toast("Nothing to queue — every chapter already done or in flight.");
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
      toast("Nothing to cancel — no pending translations.");
      return;
    }
    if (!(await confirm({
      title: "Cancel every pending translation?",
      description: "In-flight calls can't be stopped but their results will be discarded.",
      confirmText: "Cancel all",
      cancelText: "Keep running",
      destructive: true,
    }))) return;
    setCancellingAll(true);
    try {
      const res = await fetch("/api/books/translate-cancel-all", { method: "POST" });
      if (!res.ok) {
        toast(`Cancel failed: ${await res.text()}`, { variant: "error" });
        return;
      }
      const data = await res.json();
      toast(`Cancelled ${data.cancelled} translation(s) across ${data.booksTouched} book(s).`);
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
        toast(`Import failed: ${text}`, { variant: "error" });
        return;
      }
      const data = await res.json();
      toast(`Imported "${data.title}" — ${data.chapters} chapters, ${data.translations} translations.`, { variant: "success" });
      fetchBooks();
    } finally {
      setImporting(false);
    }
  };

  const navLinks = [
    // Dictionaries: admin-only (install/manage surface). Lookup stays open
    // for all users inside the reader popover.
    { href: "/dictionary", label: "Dictionaries", adminOnly: true },
    { href: "/learn", label: "Learn", adminOnly: false },
    { href: "/vocabulary", label: "Vocabulary", adminOnly: false },
    { href: "/progress", label: "Progress", adminOnly: false },
    { href: "/settings", label: "Settings", adminOnly: false },
  ].filter((item) => !item.adminOnly || isAdmin);

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
      toast(`Delete failed: ${await res.text()}`, { variant: "error" });
      return;
    }
    const data: { succeeded: number; failed: Array<{ id: string; error: string }> } = await res.json();
    const failedIds = new Set(data.failed.map((f) => f.id));
    if (data.failed.length > 0) {
      toast(`${data.succeeded} of ${ids.length} deleted. ${data.failed.length} failed.`, { variant: "error" });
      bookSelect.remove(ids.filter((id) => !failedIds.has(id)));
    } else {
      bookSelect.exit();
    }
    // Deleted top-level books only shrink the book grid; drop them locally
    // instead of reloading both lists from Turso.
    setBooks((prev) => prev.filter((b) => !ids.includes(b.id) || failedIds.has(b.id)));
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
      toast(`Move failed: ${await res.text()}`, { variant: "error" });
      return;
    }
    const data: { succeeded: number; failed: Array<{ id: string; error: string }> } = await res.json();
    const failedIds = new Set(data.failed.map((f) => f.id));
    if (data.failed.length > 0) {
      toast(`${data.succeeded} of ${ids.length} moved. ${data.failed.length} failed.`, { variant: "error" });
      bookSelect.remove(ids.filter((id) => !failedIds.has(id)));
    } else {
      bookSelect.exit();
    }
    // Books moved into a collection leave the top-level grid; "move" to
    // top level is a no-op here since these books are already top-level.
    if (collectionId) {
      setBooks((prev) => prev.filter((b) => !ids.includes(b.id) || failedIds.has(b.id)));
      if (data.succeeded > 0) {
        setCollections((prev) =>
          prev.map((c) =>
            c.id === collectionId
              ? { ...c, bookCount: c.bookCount + data.succeeded }
              : c,
          ),
        );
        fetchCollections();
      }
    }
  };

  // Drag-and-drop: reorder collections, reorder top-level books, or drop
  // a book onto a collection card to move it in. All three update local
  // state optimistically and persist in the background; failures revert
  // via a refetch.
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeType = active.data.current?.type;
    const overType = over.data.current?.type;

    if (activeType === "collection" && overType === "collection") {
      const oldIndex = collections.findIndex((c) => c.id === active.id);
      const newIndex = collections.findIndex((c) => c.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      const next = arrayMove(collections, oldIndex, newIndex);
      setCollections(next);
      const res = await fetch("/api/collections/order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: next.map((c) => c.id) }),
      }).catch(() => null);
      if (!res?.ok) {
        toast("Reorder failed", { variant: "error" });
        fetchCollections();
      }
      return;
    }

    if (activeType === "book" && overType === "collection") {
      const book = books.find((b) => b.id === active.id);
      if (!book) return;
      const targetId = String(over.id);
      setBooks((prev) => prev.filter((b) => b.id !== active.id));
      setCollections((prev) =>
        prev.map((c) =>
          c.id === targetId ? { ...c, bookCount: c.bookCount + 1 } : c,
        ),
      );
      const res = await fetch(`/api/books/${active.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collectionId: targetId }),
      }).catch(() => null);
      if (!res?.ok) {
        toast("Move failed", { variant: "error" });
        fetchBooks();
        fetchCollections();
      } else {
        // The collection cover can change server-side; refresh quietly.
        fetchCollections();
      }
      return;
    }

    if (activeType === "book" && overType === "book") {
      const oldIndex = books.findIndex((b) => b.id === active.id);
      const newIndex = books.findIndex((b) => b.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      const next = arrayMove(books, oldIndex, newIndex);
      setBooks(next);
      const res = await fetch("/api/books/order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: next.map((b) => b.id) }),
      }).catch(() => null);
      if (!res?.ok) {
        toast("Reorder failed", { variant: "error" });
        fetchBooks();
      }
    }
  };

  const handleBulkDeleteCollections = async () => {
    const ids = Array.from(collectionSelect.selected);
    if (ids.length === 0) return;
    const totalBooks = collections
      .filter((c) => collectionSelect.selected.has(c.id))
      .reduce((n, c) => n + c.bookCount, 0);
    const description =
      totalBooks > 0
        ? `All ${totalBooks} ${totalBooks === 1 ? "book" : "books"} inside will also be deleted. This can't be undone.`
        : "This can't be undone.";
    if (!(await confirm({
      title: `Delete ${ids.length} ${ids.length === 1 ? "collection" : "collections"}?`,
      description,
      confirmText: "Delete",
      destructive: true,
    }))) return;
    const res = await fetch("/api/collections/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", ids }),
    });
    if (!res.ok) {
      toast(`Delete failed: ${await res.text()}`, { variant: "error" });
      return;
    }
    const data: { succeeded: number; failed: Array<{ id: string; error: string }> } = await res.json();
    if (data.failed.length > 0) {
      toast(`${data.succeeded} of ${ids.length} deleted. ${data.failed.length} failed.`, { variant: "error" });
      collectionSelect.remove(ids.filter((id) => !data.failed.some((f) => f.id === id)));
    } else {
      collectionSelect.exit();
    }
    fetchBooks();
    fetchCollections();
  };

  return (
    <div className="min-h-screen px-6 py-10 sm:py-14 max-w-6xl mx-auto">
      <header className="mb-12 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
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
        <nav className="hidden lg:flex items-center gap-1 text-sm animate-in fade-in duration-700 delay-100">
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
            { href: "/learn", label: "Learn", adminOnly: false },
            { href: "/vocabulary", label: "Vocabulary", adminOnly: false },
            { href: "/progress", label: "Progress", adminOnly: false },
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
        <nav className="flex items-center justify-between gap-2 text-sm animate-in fade-in duration-700 delay-100 lg:hidden">
          <div className="flex items-center gap-1">
            <CreditsBadge />
            <UserButton />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Open navigation menu"
                >
                  <Menu />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-48">
              {isAdmin && (
                <>
                  <DropdownMenuItem onClick={handleTranslateAllLibrary} disabled={sweeping}>
                    {sweeping ? "Queueing..." : "Translate all"}
                  </DropdownMenuItem>
                  {books.some((b) => (b.pendingTranslations ?? 0) > 0) && (
                    <DropdownMenuItem
                      onClick={handleCancelAll}
                      disabled={cancellingAll}
                      className="text-destructive focus:text-destructive"
                    >
                      {cancellingAll ? "Cancelling..." : "Cancel all"}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={() => importInputRef.current?.click()}
                    disabled={importing}
                  >
                    {importing ? "Importing..." : "Import"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {navLinks.map((item) => (
                <DropdownMenuItem key={item.href} render={<Link href={item.href} />}>
                  {item.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,.prism.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImport(f);
              e.target.value = "";
            }}
          />
        </nav>
      </header>

      <section className="mb-12 animate-in fade-in slide-in-from-bottom-3 duration-700 delay-150">
        <UploadZone
          onUploadComplete={() => {
            // Refresh both: the book itself plus collection cover/count if
            // it was uploaded into one. Cheap enough that we always do both.
            fetchBooks();
            fetchCollections();
          }}
          collections={collections}
        />
      </section>

      <DndContext
        sensors={dndSensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
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
            Group books into a series — the first book&apos;s cover becomes the shelf.
          </p>
        ) : (
          <SortableContext
            items={collections.map((c) => c.id)}
            strategy={rectSortingStrategy}
          >
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5">
              {collections.map((c, i) => (
                <SortableGridItem
                  key={c.id}
                  id={c.id}
                  type="collection"
                  disabled={
                    collectionSelect.mode ||
                    bookSelect.mode ||
                    !currentUser ||
                    c.userId !== currentUser.id
                  }
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
                </SortableGridItem>
              ))}
            </div>
          </SortableContext>
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
          <SortableContext
            items={books.map((b) => b.id)}
            strategy={rectSortingStrategy}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {books.map((book, i) => (
                <SortableGridItem
                  key={book.id}
                  id={book.id}
                  type="book"
                  disabled={
                    bookSelect.mode ||
                    collectionSelect.mode ||
                    !currentUser ||
                    book.userId !== currentUser.id
                  }
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
                </SortableGridItem>
              ))}
            </div>
          </SortableContext>
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
      </DndContext>

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
