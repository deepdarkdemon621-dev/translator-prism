"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { TopBar } from "./TopBar";
import { BottomBar } from "./BottomBar";
import { ChapterSidebar } from "./ChapterSidebar";
import { ColumnView } from "./ColumnView";
import { MobileParagraphView } from "./MobileParagraphView";
import { SettingsDrawer } from "./SettingsDrawer";
import { WordLookupPopover, type WordSelection } from "./WordLookupPopover";
import { useReaderPrefs } from "@/lib/reader/prefs";
import {
  orderVisibleLangs,
  toggleVisibleLang,
  type ReaderLang,
} from "@/lib/reader/language-selection";
import type { TokenClickPayload, TokenKnowledge, TokenSpan } from "./ParagraphBlock";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface Chapter {
  id: string;
  index: number;
  title: string;
  status: string;
}

interface Paragraph {
  id: string;
  seq: number;
  sourceText: string;
  sourceMarkup: string;
  kind: "text" | "image";
  translations: Record<
    string,
    { text: string | null; status: string; errorMessage?: string | null }
  >;
}

interface ChapterContent {
  id: string;
  title: string;
  status: string;
  paragraphs: Paragraph[];
}

interface ReaderLayoutProps {
  bookId: string;
  bookTitle: string;
  sourceLang: string;
  chapters: Chapter[];
  initialChapterIndex: number;
}

const LANG_LABELS: Record<string, string> = {
  ja: "Japanese",
  zh: "Chinese",
  en: "English",
};

const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 28;

export function ReaderLayout({
  bookId,
  bookTitle,
  sourceLang,
  chapters,
  initialChapterIndex,
}: ReaderLayoutProps) {
  const [currentIndex, setCurrentIndex] = useState(initialChapterIndex);
  const [content, setContent] = useState<ChapterContent | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [activeParagraphId, setActiveParagraphId] = useState<string | null>(null);
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null);
  const { prefs: settings, setPrefs: setSettings, update: updateSettings } = useReaderPrefs();
  const [wordSelection, setWordSelection] = useState<WordSelection | null>(null);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const confirm = useConfirm();

  // ---- Immersive reading (L3): tokens + word knowledge ----
  const immersiveActive = sourceLang === "ja" && settings.highlightUnknown;
  const [tokenMap, setTokenMap] = useState<Record<string, TokenSpan[]>>({});
  const [knowledge, setKnowledge] = useState<{
    statuses: Record<string, string>;
    learning: Set<string>;
  } | null>(null);
  const tokenCacheRef = useRef(new Map<string, Record<string, TokenSpan[]>>());

  const currentChapter = chapters.find((ch) => ch.index === currentIndex);
  const visibleLangs = orderVisibleLangs(
    settings.visibleLangs,
    settings.langOrder,
    sourceLang,
  );

  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const syncSidebar = () => setSidebarOpen(query.matches);
    syncSidebar();
    query.addEventListener("change", syncSidebar);
    return () => query.removeEventListener("change", syncSidebar);
  }, []);

  const handleToggleLanguage = useCallback(
    (lang: ReaderLang) => {
      const anchorId = activeParagraphId || highlightedId || content?.paragraphs[0]?.id || null;
      setPendingScrollId(anchorId);
      updateSettings({
        visibleLangs: toggleVisibleLang(settings.visibleLangs, lang, settings.langOrder),
      });
    },
    [
      activeParagraphId,
      content?.paragraphs,
      highlightedId,
      settings.langOrder,
      settings.visibleLangs,
      updateSettings,
    ],
  );

  const swapLangs = useCallback(
    (a: string, b: string) => {
      if (a === b) return;
      const next = [...settings.langOrder];
      const ia = next.indexOf(a as ReaderLang);
      const ib = next.indexOf(b as ReaderLang);
      if (ia === -1 || ib === -1) return;
      [next[ia], next[ib]] = [next[ib], next[ia]];
      updateSettings({ langOrder: next });
    },
    [settings.langOrder, updateSettings],
  );

  useEffect(() => {
    if (!pendingScrollId) return;
    const frame = requestAnimationFrame(() => {
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>("[data-reader-paragraph-id]"),
      ).filter((node) => node.dataset.readerParagraphId === pendingScrollId);
      nodes.forEach((node) => node.scrollIntoView({ block: "start" }));
      setPendingScrollId(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingScrollId, visibleLangs]);

  // Load the user's word-knowledge map once per session (ja only).
  useEffect(() => {
    if (!immersiveActive) return;
    let cancelled = false;
    fetch("/api/word-status?lang=ja")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { statuses: Record<string, string>; learning: string[] } | null) => {
        if (!cancelled && data) {
          setKnowledge({ statuses: data.statuses, learning: new Set(data.learning) });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [immersiveActive]);

  // Fetch token spans for the current chapter (memoized per chapter).
  useEffect(() => {
    if (!immersiveActive) return;
    const ch = chapters.find((c) => c.index === currentIndex);
    if (!ch) return;
    const cached = tokenCacheRef.current.get(ch.id);
    if (cached) {
      setTokenMap(cached);
      return;
    }
    let cancelled = false;
    fetch(`/api/chapters/${ch.id}/tokens`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { tokens: Record<string, TokenSpan[]> } | null) => {
        if (cancelled || !data) return;
        tokenCacheRef.current.set(ch.id, data.tokens);
        if (tokenCacheRef.current.size > 5) {
          const oldest = tokenCacheRef.current.keys().next().value;
          if (oldest != null && oldest !== ch.id) tokenCacheRef.current.delete(oldest);
        }
        setTokenMap(data.tokens);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [immersiveActive, chapters, currentIndex]);

  const statusForLemma = useCallback(
    (lemma: string): TokenKnowledge => {
      if (!knowledge) return "known"; // render plain until the map loads
      const mark = knowledge.statuses[lemma];
      if (mark === "known" || mark === "ignored") return "known";
      if (knowledge.learning.has(lemma)) return "learning";
      return "unknown";
    },
    [knowledge],
  );

  const handleTokenClick = useCallback(
    (payload: TokenClickPayload) => {
      setWordSelection({
        word: payload.surface,
        lemma: payload.lemma,
        lang: sourceLang,
        rect: payload.rect,
        contextText: payload.contextText,
      });
    },
    [sourceLang],
  );

  const handleMarkStatus = useCallback(
    (lemma: string, status: "known" | "ignored") => {
      setKnowledge((prev) =>
        prev
          ? { ...prev, statuses: { ...prev.statuses, [lemma]: status } }
          : prev,
      );
      fetch("/api/word-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: "ja", lemma, status }),
      }).catch(() => {});
    },
    [],
  );

  const handleSavedWord = useCallback((lemma: string) => {
    setKnowledge((prev) =>
      prev
        ? { ...prev, learning: new Set(prev.learning).add(lemma) }
        : prev,
    );
  }, []);

  // Chapter coverage: share of content tokens whose lemma isn't unknown.
  const coverage = useMemo(() => {
    if (!immersiveActive || !knowledge || !content) return null;
    let total = 0;
    let unknownTokens = 0;
    const unknownLemmas = new Set<string>();
    for (const p of content.paragraphs) {
      const toks = tokenMap[p.id];
      if (!toks) continue;
      for (const [, , lemma] of toks) {
        total++;
        if (statusForLemma(lemma) === "unknown") {
          unknownTokens++;
          unknownLemmas.add(lemma);
        }
      }
    }
    if (total === 0) return null;
    return {
      pct: Math.round(((total - unknownTokens) / total) * 100),
      unknownLemmas,
    };
  }, [immersiveActive, knowledge, content, tokenMap, statusForLemma]);

  const handleMarkRestKnown = useCallback(async () => {
    if (!coverage || coverage.unknownLemmas.size === 0) return;
    const lemmas = Array.from(coverage.unknownLemmas);
    if (
      !(await confirm({
        title: `Mark ${lemmas.length} words as known?`,
        description:
          "Every remaining highlighted word in this chapter will stop being highlighted everywhere.",
        confirmText: "Mark known",
      }))
    )
      return;
    setKnowledge((prev) => {
      if (!prev) return prev;
      const statuses = { ...prev.statuses };
      for (const l of lemmas) if (!statuses[l]) statuses[l] = "known";
      return { ...prev, statuses };
    });
    fetch("/api/word-status", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang: "ja", lemmas, status: "known" }),
    }).catch(() => {});
  }, [coverage, confirm]);

  // ---- Reading heartbeat (L6): one minute of visible reading per ping;
  // chapter characters are credited when the user moves forward past a
  // chapter (they presumably read it). Throttled to protect Turso quota.
  const localDay = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const sendSession = useCallback(
    (payload: { durationMs?: number; charsRead?: number }) => {
      fetch("/api/reading-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, day: localDay(), ...payload }),
      }).catch(() => {});
    },
    [bookId],
  );

  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden) sendSession({ durationMs: 60_000 });
    }, 60_000);
    return () => clearInterval(interval);
  }, [sendSession]);

  const prevChapterRef = useRef<{ index: number; chars: number } | null>(null);
  useEffect(() => {
    if (!content) return;
    const chars = content.paragraphs.reduce(
      (sum, p) => (p.kind === "text" ? sum + p.sourceText.length : sum),
      0,
    );
    const prev = prevChapterRef.current;
    if (prev && currentIndex === prev.index + 1 && prev.chars > 0) {
      sendSession({ charsRead: prev.chars });
    }
    prevChapterRef.current = { index: currentIndex, chars };
    // content identity changes when the chapter loads; currentIndex pairs it.
  }, [content, currentIndex, sendSession]);

  // Next-chapter prefetch cache. Only fully translated chapters are cached
  // — their payload is stable, so serving it on a chapter flip is safe and
  // instant. In-progress chapters always fetch fresh (they poll anyway).
  const prefetchCache = useRef(new Map<string, ChapterContent>());

  const fetchContent = useCallback(async (chapterId: string) => {
    const cached = prefetchCache.current.get(chapterId);
    if (cached) {
      prefetchCache.current.delete(chapterId);
      setContent(cached);
      return;
    }
    try {
      const res = await fetch(`/api/chapters/${chapterId}`);
      if (res.ok) {
        setContent(await res.json());
      } else {
        console.error(`Failed to fetch chapter ${chapterId}: ${res.status}`);
      }
    } catch (err) {
      console.error(`Error fetching chapter ${chapterId}:`, err);
    }
  }, []);

  // Warm the cache with the next chapter while the current one is read.
  useEffect(() => {
    const nextCh = chapters.find((c) => c.index === currentIndex + 1);
    if (!nextCh || nextCh.status !== "done") return;
    if (prefetchCache.current.has(nextCh.id)) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/chapters/${nextCh.id}`);
        if (!res.ok || cancelled) return;
        const payload: ChapterContent = await res.json();
        if (payload.status !== "done" || cancelled) return;
        prefetchCache.current.set(nextCh.id, payload);
        // Keep at most a few chapters in memory.
        while (prefetchCache.current.size > 3) {
          const oldest = prefetchCache.current.keys().next().value;
          if (oldest == null) break;
          prefetchCache.current.delete(oldest);
        }
      } catch {
        // Prefetch is best-effort; the normal fetch path still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentIndex, chapters]);

  const triggerTranslation = useCallback(async (chapterId: string) => {
    await fetch(`/api/chapters/${chapterId}/translate`, { method: "POST" });
  }, []);

  const handleRetryParagraph = useCallback(
    async (paragraphId: string) => {
      setRetryingIds((prev) => {
        const next = new Set(prev);
        next.add(paragraphId);
        return next;
      });
      try {
        await fetch(`/api/paragraphs/${paragraphId}/retry`, { method: "POST" });
        if (currentChapter) {
          await fetchContent(currentChapter.id);
        }
      } catch (err) {
        console.error("Retry failed:", err);
      } finally {
        setRetryingIds((prev) => {
          const next = new Set(prev);
          next.delete(paragraphId);
          return next;
        });
      }
    },
    [currentChapter, fetchContent],
  );

  useEffect(() => {
    const ch = chapters.find((c) => c.index === currentIndex);
    if (!ch) return;

    fetchContent(ch.id).catch(() => {});

    if (ch.status === "pending" || ch.status === "error" || ch.status === "translating") {
      triggerTranslation(ch.id).catch(() => {});
    }

    fetch(`/api/progress/${bookId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapterIndex: currentIndex }),
    }).catch(() => {});

    const nextCh = chapters.find((c) => c.index === currentIndex + 1);
    if (nextCh && nextCh.status === "pending") {
      triggerTranslation(nextCh.id).catch(() => {});
    }
  }, [currentIndex, chapters, bookId, fetchContent, triggerTranslation]);

  useEffect(() => {
    if (!currentChapter || !content) return;
    if (content.status === "done" || content.status === "error") return;

    let interval: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (!currentChapter) return;
      fetchContent(currentChapter.id).catch(() => {});
    };
    const start = () => {
      if (interval != null) return;
      interval = setInterval(tick, 10_000);
    };
    const stop = () => {
      if (interval == null) return;
      clearInterval(interval);
      interval = null;
    };
    const handleVisibility = () => {
      if (document.hidden) stop();
      else {
        tick();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [currentChapter, content, fetchContent]);

  return (
    <div className="h-screen flex flex-col bg-background">
      <TopBar
        bookTitle={bookTitle}
        chapterTitle={currentChapter?.title || ""}
        visibleLangs={visibleLangs}
        onToggleLanguage={handleToggleLanguage}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onOpenSettings={() => setSettingsOpen(true)}
        fontSize={settings.fontSize}
        onFontSizeChange={(delta) =>
          updateSettings({
            fontSize: Math.max(
              FONT_SIZE_MIN,
              Math.min(FONT_SIZE_MAX, settings.fontSize + delta),
            ),
          })
        }
      />

      <div className="flex flex-1 overflow-hidden">
        <ChapterSidebar
          chapters={chapters}
          currentIndex={currentIndex}
          onSelect={(index) => {
            setCurrentIndex(index);
            if (window.innerWidth < 768) setSidebarOpen(false);
          }}
          isOpen={sidebarOpen}
        />

        <div className="flex flex-1 overflow-hidden">
          {content && content.paragraphs.length > 0 ? (
            <>
              <div className="hidden md:flex flex-1 overflow-hidden divide-x divide-border">
                {visibleLangs.map((lang) => (
                  <ColumnView
                    key={lang}
                    lang={lang}
                    label={LANG_LABELS[lang] || lang}
                    sourceLang={sourceLang}
                    paragraphs={content.paragraphs}
                    highlightedId={highlightedId}
                    onParagraphClick={setHighlightedId}
                    onActiveParagraphChange={setActiveParagraphId}
                    onWordSelect={setWordSelection}
                    onRetryParagraph={handleRetryParagraph}
                    retryingIds={retryingIds}
                    fontSize={settings.fontSize}
                    lineHeight={settings.lineHeight}
                    fontFamily={settings.fonts[lang] || "serif"}
                    paragraphSpacing={settings.paragraphSpacing}
                    draggable={visibleLangs.length > 1}
                    onDropLang={(fromLang, toLang) => swapLangs(fromLang, toLang)}
                    tokensByParagraph={immersiveActive ? tokenMap : undefined}
                    statusForLemma={immersiveActive ? statusForLemma : undefined}
                    onTokenClick={immersiveActive ? handleTokenClick : undefined}
                  />
                ))}
              </div>
              <div className="md:hidden flex flex-1 overflow-hidden">
                <MobileParagraphView
                  sourceLang={sourceLang}
                  visibleLangs={visibleLangs}
                  labels={LANG_LABELS}
                  paragraphs={content.paragraphs}
                  highlightedId={highlightedId}
                  onParagraphClick={setHighlightedId}
                  onActiveParagraphChange={setActiveParagraphId}
                  onWordSelect={setWordSelection}
                  onRetryParagraph={handleRetryParagraph}
                  retryingIds={retryingIds}
                  fontSize={settings.fontSize}
                  lineHeight={settings.lineHeight}
                  fonts={settings.fonts}
                  paragraphSpacing={settings.paragraphSpacing}
                />
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center p-8">
              {content ? (
                <div className="text-center max-w-sm">
                  <p className="text-muted-foreground text-sm mb-1">
                    This chapter has no translatable text.
                  </p>
                  <p className="text-muted-foreground/70 text-xs mb-4">
                    It&apos;s likely a cover or image-only page.
                  </p>
                  {currentIndex < chapters.length - 1 && (
                    <button
                      onClick={() => setCurrentIndex((i) => Math.min(chapters.length - 1, i + 1))}
                      className="text-primary text-sm hover:underline"
                    >
                      Skip to next chapter
                    </button>
                  )}
                </div>
              ) : (
                <div className="text-muted-foreground text-sm">Loading...</div>
              )}
            </div>
          )}
        </div>
      </div>

      {coverage && (
        <div className="fixed bottom-16 right-4 z-40 flex items-center gap-2 rounded-full border border-border/60 bg-background/90 backdrop-blur-sm px-3 py-1.5 text-[11px] text-muted-foreground shadow-sm">
          <span className="tabular-nums">
            {coverage.pct}% known · {coverage.unknownLemmas.size} new
          </span>
          {coverage.unknownLemmas.size > 0 && (
            <button
              onClick={handleMarkRestKnown}
              className="text-primary hover:underline underline-offset-2"
              title="Mark every remaining highlighted word in this chapter as known"
            >
              Mark rest known
            </button>
          )}
        </div>
      )}

      <BottomBar
        currentIndex={currentIndex}
        totalChapters={chapters.length}
        onPrev={() => setCurrentIndex((i) => Math.max(0, i - 1))}
        onNext={() => setCurrentIndex((i) => Math.min(chapters.length - 1, i + 1))}
      />

      <SettingsDrawer
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSettingsChange={setSettings}
      />

      {wordSelection && (
        <WordLookupPopover
          selection={wordSelection}
          bookId={bookId}
          onMarkStatus={immersiveActive ? handleMarkStatus : undefined}
          onSavedWord={immersiveActive ? handleSavedWord : undefined}
          onClose={() => {
            setWordSelection(null);
            window.getSelection()?.removeAllRanges();
          }}
        />
      )}
    </div>
  );
}
