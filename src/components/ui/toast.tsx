"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";

export type ToastVariant = "default" | "success" | "error";

interface ToastOptions {
  variant?: ToastVariant;
  /** Auto-dismiss delay. Errors default to 6s, the rest to 4s. */
  durationMs?: number;
}

type ToastFn = (message: string, opts?: ToastOptions) => void;

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  leaving: boolean;
}

const ToastContext = createContext<ToastFn>(() => {});

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  default: "border-border/60 bg-background text-foreground",
  success: "border-primary/40 bg-background text-foreground",
  error: "border-destructive/50 bg-background text-destructive",
};

/**
 * Minimal toast stack replacing native alert(): bottom-center, warm-card
 * styling, auto-dismiss, click to dismiss. Mount once in the root layout
 * next to ConfirmProvider.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    // Two-phase removal so the leave transition can play.
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
    );
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 200);
  }, []);

  const toast = useCallback<ToastFn>(
    (message, opts) => {
      const id = nextId.current++;
      const variant = opts?.variant ?? "default";
      const duration = opts?.durationMs ?? (variant === "error" ? 6000 : 4000);
      setToasts((prev) => [...prev, { id, message, variant, leaving: false }]);
      setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-6 z-[100] flex flex-col items-center gap-2 px-4"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => dismiss(t.id)}
            className={`pointer-events-auto max-w-md rounded-xl border px-4 py-2.5 text-sm shadow-lg backdrop-blur-sm transition-all duration-200 text-left ${
              VARIANT_CLASSES[t.variant]
            } ${t.leaving ? "opacity-0 translate-y-1" : "opacity-100 translate-y-0 animate-in fade-in slide-in-from-bottom-2"}`}
          >
            {t.message}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  return useContext(ToastContext);
}
