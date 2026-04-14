"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

export interface ReaderPrefs {
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: "compact" | "standard" | "relaxed";
  theme: "dark" | "light" | "sepia";
  fonts: { ja: string; zh: string; en: string };
  // Column order for the reader view. The book's source language is always
  // pinned first regardless of where it appears here; the remaining two
  // langs render in the order given. Drag-to-reorder on column headers
  // writes back into this list. Defaults to ja → zh → en which matches
  // the pre-2026-04 behavior (primary use case is JA novels with ZH first).
  langOrder: Array<"ja" | "zh" | "en">;
}

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  fontSize: 16,
  lineHeight: 1.8,
  paragraphSpacing: "standard",
  theme: "dark",
  fonts: {
    ja: "var(--font-noto-jp), serif",
    zh: "var(--font-noto-sc), serif",
    en: "Georgia, serif",
  },
  langOrder: ["ja", "zh", "en"],
};

const STORAGE_KEY = "reader-prefs.v1";
const THEME_CLASSES = ["theme-dark", "theme-light", "theme-sepia"];

export function applyTheme(theme: ReaderPrefs["theme"]) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove(...THEME_CLASSES, "dark");
  root.classList.add(`theme-${theme}`);
  // Keep Tailwind's `.dark` variant working for components that still rely on it.
  if (theme === "dark") root.classList.add("dark");
}

function parse(raw: string | null): ReaderPrefs {
  if (!raw) return DEFAULT_READER_PREFS;
  try {
    const parsed = JSON.parse(raw) as Partial<ReaderPrefs>;
    // Validate langOrder: must be a permutation of ['ja','zh','en']. If a
    // user somehow has a corrupt array (missing langs, duplicates), fall
    // back to defaults rather than crash the reader.
    const ALL: Array<"ja" | "zh" | "en"> = ["ja", "zh", "en"];
    const order = Array.isArray(parsed.langOrder) && parsed.langOrder.length === 3
      && ALL.every((l) => parsed.langOrder!.includes(l))
      ? (parsed.langOrder as Array<"ja" | "zh" | "en">)
      : DEFAULT_READER_PREFS.langOrder;
    return {
      ...DEFAULT_READER_PREFS,
      ...parsed,
      fonts: { ...DEFAULT_READER_PREFS.fonts, ...(parsed.fonts ?? {}) },
      langOrder: order,
    };
  } catch {
    return DEFAULT_READER_PREFS;
  }
}

// ---------- External store ----------
// The prefs live outside React so we can use useSyncExternalStore, which is
// the idiomatic way to bridge localStorage without tripping React 19's
// "setState in effect" rule. We cache the parsed snapshot and only rebuild it
// when the underlying string changes — useSyncExternalStore requires
// referentially stable return values between renders.

type Listener = () => void;
const listeners = new Set<Listener>();
let snapshot: ReaderPrefs = DEFAULT_READER_PREFS;
let snapshotRaw: string | null | undefined = undefined;

function readSnapshot(): ReaderPrefs {
  if (typeof window === "undefined") return DEFAULT_READER_PREFS;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw !== snapshotRaw) {
    snapshotRaw = raw;
    snapshot = parse(raw);
  }
  return snapshot;
}

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  // React to changes from other tabs too.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      // Invalidate the cache so next readSnapshot reparses.
      snapshotRaw = undefined;
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function writePrefs(next: ReaderPrefs) {
  const raw = JSON.stringify(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // Storage unavailable — non-fatal; keep in-memory snapshot in sync.
  }
  snapshotRaw = raw;
  snapshot = next;
  emit();
}

function getServerSnapshot(): ReaderPrefs {
  return DEFAULT_READER_PREFS;
}

/**
 * Load reader prefs from localStorage, subscribe to changes, apply the
 * chosen theme to the document root, and persist updates. First render
 * returns defaults (matching the server) so hydration lines up; real values
 * swap in immediately after mount.
 */
export function useReaderPrefs() {
  const prefs = useSyncExternalStore(subscribe, readSnapshot, getServerSnapshot);

  // Sync the theme class on the <html> element whenever prefs change.
  useEffect(() => {
    applyTheme(prefs.theme);
  }, [prefs.theme]);

  const setPrefs = useCallback((next: ReaderPrefs) => {
    writePrefs(next);
  }, []);

  const update = useCallback((patch: Partial<ReaderPrefs>) => {
    writePrefs({ ...readSnapshot(), ...patch });
  }, []);

  return { prefs, setPrefs, update };
}
