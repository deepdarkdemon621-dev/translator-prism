"use client";

import { useCallback, useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { PricingDialog } from "@/components/PricingDialog";
import { translateAllWithGate } from "@/lib/translate/client";

interface UploadZoneProps {
  onUploadComplete: () => void;
}

interface UploadedBook {
  id: string;
  title: string;
}

export function UploadZone({ onUploadComplete }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After a successful upload we hold the new book briefly so the pricing
  // dialog can open with context. Cleared when the user skips or buys,
  // which also triggers the library refresh.
  const [pending, setPending] = useState<UploadedBook | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  // Admin-only: auto-kick translate-all after a successful upload. Goes
  // through the same cost gate as the manual button so paid-provider
  // users still see an estimate before confirming.
  const [autoTranslate, setAutoTranslate] = useState(false);
  // Admin-only: visibility for the uploaded book. Public = visible to
  // every signed-in user (showcase). Private = owner-only. Default public
  // because the admin's library is intended to be the "shared shelf".
  // Regular users always upload private — no toggle shown.
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  // Destination collection for the upload. "" means top level.
  const [targetCollectionId, setTargetCollectionId] = useState<string>("");
  const [ownCollections, setOwnCollections] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/user")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { isAdmin?: boolean } | null) => {
        if (!cancelled && data?.isAdmin) setIsAdmin(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // /api/collections returns own + admin-public for regulars, all for
    // admin. The server's upload handler silently drops a non-owned
    // collectionId, so a loose filter here is fine.
    fetch("/api/collections")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ id: string; name: string }>) => {
        if (!cancelled) setOwnCollections(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleUpload = useCallback(
    async (file: File) => {
      if (!file.name.endsWith(".epub")) {
        setError("Only EPUB files are supported");
        return;
      }

      setIsUploading(true);
      setError(null);

      try {
        const formData = new FormData();
        formData.append("file", file);
        // Only admin's selection matters server-side — the route ignores
        // this field for regular users and forces 'private'. We still send
        // it for admin so their toggle is respected.
        if (isAdmin) formData.append("visibility", visibility);
        if (targetCollectionId) formData.append("collectionId", targetCollectionId);

        const res = await fetch("/api/books/upload", {
          method: "POST",
          body: formData,
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Upload failed");
        }
        // Admin skips the pricing gate — their translations go through the
        // translate-all cost gate instead, and showcase uploads shouldn't
        // be blocked by a per-chapter bundle picker.
        if (isAdmin) {
          onUploadComplete();
        } else {
          setPending({ id: data.id, title: data.title });
        }

        if (autoTranslate) {
          // Kick translate-all in the background. Errors (incl. cost-gate
          // cancels) surface via alert inside translateAllWithGate. We
          // don't await because the upload should clear the spinner
          // independently of how long the user spends on the confirm.
          translateAllWithGate(`/api/books/${data.id}/translate-all`)
            .then((r) => {
              if (r.error) console.warn("Auto-translate error:", r.error);
            })
            .catch((err) => console.warn("Auto-translate failed:", err));
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setIsUploading(false);
      }
    },
    [autoTranslate, isAdmin, visibility, targetCollectionId, onUploadComplete],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleUpload(file);
    },
    [handleUpload],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleUpload(file);
    },
    [handleUpload],
  );

  const handlePricingDone = useCallback(() => {
    setPending(null);
    onUploadComplete();
  }, [onUploadComplete]);

  return (
    <>
      <div
        className={`relative border border-dashed rounded-2xl px-8 py-14 text-center transition-all duration-300 ease-out ${
          isDragging
            ? "border-primary bg-primary/5 scale-[1.01]"
            : "border-border hover:border-primary/40 hover:bg-accent/20"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        {isUploading ? (
          <div className="flex flex-col items-center gap-3">
            <div className="h-10 w-10 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
            <p className="text-muted-foreground text-sm">Uploading and parsing…</p>
          </div>
        ) : (
          <>
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <p
              className="text-lg mb-1 tracking-tight"
              style={{ fontFamily: "var(--font-heading)" }}
            >
              Drop an EPUB here
            </p>
            <p className="text-sm text-muted-foreground mb-5">
              …or click below to select a file
            </p>
            <label className="inline-flex cursor-pointer">
              <span className={buttonVariants({ variant: "outline", size: "sm" })}>
                Select EPUB
              </span>
              <input
                type="file"
                accept=".epub"
                className="hidden"
                onChange={handleFileSelect}
              />
            </label>
          </>
        )}
        {error && <p className="text-destructive mt-3 text-sm">{error}</p>}
      </div>

      <div className="mt-3 flex items-center gap-3 text-sm text-muted-foreground">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <span className="text-xs uppercase tracking-wider">Collection</span>
          <select
            className="rounded-md border border-border/70 bg-background px-2 py-1 text-sm"
            value={targetCollectionId}
            onChange={(e) => setTargetCollectionId(e.target.value)}
          >
            <option value="">Top level</option>
            {ownCollections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isAdmin && (
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
          {/* Admin-only visibility selector. Stored per-upload; resets
              implicitly on page navigation. Radio pair so the two states
              are mutually exclusive and the current choice is always
              visible at a glance. */}
          <div className="flex items-center gap-3 select-none">
            <span className="text-xs uppercase tracking-wider">Visibility</span>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="visibility"
                value="public"
                checked={visibility === "public"}
                onChange={() => setVisibility("public")}
                className="accent-primary"
              />
              <span>Public</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="visibility"
                value="private"
                checked={visibility === "private"}
                onChange={() => setVisibility("private")}
                className="accent-primary"
              />
              <span>Private</span>
            </label>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoTranslate}
              onChange={(e) => setAutoTranslate(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <span>Auto-translate after upload</span>
          </label>
        </div>
      )}

      <PricingDialog
        bookId={pending?.id ?? null}
        bookTitle={pending?.title}
        onDone={handlePricingDone}
      />
    </>
  );
}
