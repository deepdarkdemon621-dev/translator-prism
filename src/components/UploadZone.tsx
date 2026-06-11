"use client";

import { useCallback, useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { PricingDialog } from "@/components/PricingDialog";
import { translateAllWithGate } from "@/lib/translate/client";
import { uploadEpubFilesSequentially } from "@/lib/upload/batch-client";
import type { UploadedBook } from "@/lib/upload/client";

interface UploadZoneProps {
  onUploadComplete: () => void;
  /** Collections the caller already has loaded. Kept as a prop so
   *  newly-created collections in the parent appear in the dropdown
   *  without a page refresh. */
  collections: Array<{ id: string; name: string }>;
}

export function UploadZone({ onUploadComplete, collections }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    fileName: string;
    index: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Successful regular-user uploads wait here so the pricing dialog can
  // open one book at a time. Cleared when the user skips or buys.
  const [pendingBooks, setPendingBooks] = useState<UploadedBook[]>([]);
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

  const handleUpload = useCallback(
    async (files: File[]) => {
      if (isUploading) return;
      if (files.length === 0) return;

      const epubFiles = files.filter((file) =>
        file.name.toLowerCase().endsWith(".epub"),
      );
      const skippedFiles = files.filter(
        (file) => !file.name.toLowerCase().endsWith(".epub"),
      );
      if (epubFiles.length === 0) {
        setError("Only EPUB files are supported");
        return;
      }

      setIsUploading(true);
      setUploadProgress(null);
      setError(
        skippedFiles.length
          ? `Skipped non-EPUB file${skippedFiles.length === 1 ? "" : "s"}: ${skippedFiles
              .map((file) => file.name)
              .join(", ")}`
          : null,
      );

      try {
        const result = await uploadEpubFilesSequentially({
          files: epubFiles,
          isAdmin,
          visibility,
          targetCollectionId,
          onFileStart: (fileName, index, total) => {
            setUploadProgress({ fileName, index, total });
          },
        });

        if (result.successes.length > 0 && isAdmin) {
          onUploadComplete();
        }
        if (!isAdmin && result.successes.length > 0) {
          setPendingBooks((current) => [
            ...current,
            ...result.successes.map((success) => ({
              id: success.book.id,
              title: success.book.title,
            })),
          ]);
        }

        if (autoTranslate && result.successes.length > 0) {
          // Kick translate-all in the background. Errors (incl. cost-gate
          // cancels) surface via alert inside translateAllWithGate. We
          // don't await because the upload should clear the spinner
          // independently of how long the user spends on the confirm.
          for (const success of result.successes) {
            translateAllWithGate(`/api/books/${success.book.id}/translate-all`)
              .then((r) => {
                if (r.error) console.warn("Auto-translate error:", r.error);
              })
              .catch((err) => console.warn("Auto-translate failed:", err));
          }
        }

        if (result.failures.length > 0) {
          setError(
            `Failed upload${result.failures.length === 1 ? "" : "s"}: ${result.failures
              .map((failure) => `${failure.fileName} (${failure.error})`)
              .join("; ")}`,
          );
        } else if (skippedFiles.length === 0) {
          setError(null);
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setIsUploading(false);
        setUploadProgress(null);
      }
    },
    [
      autoTranslate,
      isAdmin,
      isUploading,
      visibility,
      targetCollectionId,
      onUploadComplete,
    ],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      handleUpload(Array.from(e.dataTransfer.files));
    },
    [handleUpload],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      handleUpload(Array.from(e.target.files ?? []));
      e.target.value = "";
    },
    [handleUpload],
  );

  const handlePricingDone = useCallback(() => {
    setPendingBooks((current) => current.slice(1));
    onUploadComplete();
  }, [onUploadComplete]);

  const pending = pendingBooks[0] ?? null;

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
            <p className="text-muted-foreground text-sm">
              {uploadProgress
                ? `Uploading ${uploadProgress.index}/${uploadProgress.total}: ${uploadProgress.fileName}`
                : "Uploading and parsing..."}
            </p>
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
              Drop EPUB files here
            </p>
            <p className="text-sm text-muted-foreground mb-5">
              or click below to select one or more files
            </p>
            <label className="inline-flex cursor-pointer">
              <span className={buttonVariants({ variant: "outline", size: "sm" })}>
                Select EPUBs
              </span>
              <input
                type="file"
                accept=".epub"
                multiple
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
            {collections.map((c) => (
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
