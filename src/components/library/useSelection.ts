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
