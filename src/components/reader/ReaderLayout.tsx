"use client";

import { useState, useEffect, useCallback } from "react";
import { TopBar, ViewMode } from "./TopBar";
import { BottomBar } from "./BottomBar";
import { ChapterSidebar } from "./ChapterSidebar";
import { ColumnView } from "./ColumnView";
import { SettingsDrawer } from "./SettingsDrawer";
import { WordLookupPopover, type WordSelection } from "./WordLookupPopover";
import { useReaderPrefs } from "@/lib/reader/prefs";

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
  ja: "日本語",
  zh: "中文",
  en: "English",
};

type Lang = "ja" | "zh" | "en";

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
  const [viewMode, setViewMode] = useState<ViewMode>("triple");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const { prefs: settings, setPrefs: setSettings, update: updateSettings } = useReaderPrefs();
  const [wordSelection, setWordSelection] = useState<WordSelection | null>(null);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());

  const currentChapter = chapters.find((ch) => ch.index === currentIndex);

  // Determine which languages to show. Source is always first; the remaining
  // two come from the user-configurable langOrder so drag-reordering a
  // column here actually persists. visibleLangs is sliced by viewMode
  // (single → just source, dual → source + 1 target, triple → all three).
  const visibleLangs = (() => {
    const targets = settings.langOrder.filter((l) => l !== sourceLang);
    if (viewMode === "single") return [sourceLang];
    if (viewMode === "dual") return [sourceLang, targets[0]];
    return [sourceLang, ...targets];
  })();

  // Swap two target langs in the persisted order. We only ever swap
  // non-source columns — the source stays pinned at index 0 visually but
  // its position inside langOrder doesn't matter for rendering.
  const swapLangs = useCallback(
    (a: string, b: string) => {
      if (a === b) return;
      if (a === sourceLang || b === sourceLang) return;
      const next = [...settings.langOrder] as Lang[];
      const ia = next.indexOf(a as Lang);
      const ib = next.indexOf(b as Lang);
      if (ia === -1 || ib === -1) return;
      [next[ia], next[ib]] = [next[ib], next[ia]];
      updateSettings({ langOrder: next });
    },
    [settings.langOrder, sourceLang, updateSettings],
  );

  // Fetch chapter content
  const fetchContent = useCallback(async (chapterId: string) => {
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

  // Trigger translation
  const triggerTranslation = useCallback(async (chapterId: string) => {
    await fetch(`/api/chapters/${chapterId}/translate`, { method: "POST" });
  }, []);

  // Retry a single paragraph's failed translations
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

  // Load chapter when index changes
  useEffect(() => {
    const ch = chapters.find((c) => c.index === currentIndex);
    if (!ch) return;

    fetchContent(ch.id).catch(() => {});

    // Trigger translation if needed. "translating" is included because the
    // in-memory queue is lost on server restart — re-calling translate is safe
    // because the route skips paragraphs already marked done.
    if (ch.status === "pending" || ch.status === "error" || ch.status === "translating") {
      triggerTranslation(ch.id).catch(() => {});
    }

    // Save progress
    fetch(`/api/progress/${bookId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapterIndex: currentIndex }),
    }).catch(() => {});

    // Prefetch next chapter
    const nextCh = chapters.find((c) => c.index === currentIndex + 1);
    if (nextCh && nextCh.status === "pending") {
      triggerTranslation(nextCh.id).catch(() => {});
    }
  }, [currentIndex, chapters, bookId, fetchContent, triggerTranslation]);

  // Poll for translation status while the chapter is still progressing.
  // Terminal states ("done", "error") stop polling — a user Retry re-sets
  // the chapter to "translating" via the retry API, which restarts the loop.
  useEffect(() => {
    if (!currentChapter || !content) return;
    if (content.status === "done" || content.status === "error") return;

    const interval = setInterval(() => {
      if (!currentChapter) return;
      fetchContent(currentChapter.id).catch(() => {});
    }, 3000);

    return () => clearInterval(interval);
  }, [currentChapter, content, fetchContent]);

  return (
    <div className="h-screen flex flex-col bg-background">
      <TopBar
        bookTitle={bookTitle}
        chapterTitle={currentChapter?.title || ""}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
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
          onSelect={setCurrentIndex}
          isOpen={sidebarOpen}
        />

        <div className="flex flex-1 overflow-hidden divide-x divide-border">
          {content && content.paragraphs.length > 0 ? (
            visibleLangs.map((lang) => {
              // Only non-source target columns are draggable, and only in
              // triple view where there's actually a sibling to swap with.
              // Dual view has a single target col — nothing to reorder.
              const isTarget = lang !== sourceLang;
              const canDrag = isTarget && viewMode === "triple";
              return (
                <ColumnView
                  key={lang}
                  lang={lang}
                  label={LANG_LABELS[lang] || lang}
                  sourceLang={sourceLang}
                  paragraphs={content.paragraphs}
                  highlightedId={highlightedId}
                  onParagraphClick={setHighlightedId}
                  onWordSelect={setWordSelection}
                  onRetryParagraph={handleRetryParagraph}
                  retryingIds={retryingIds}
                  fontSize={settings.fontSize}
                  lineHeight={settings.lineHeight}
                  fontFamily={settings.fonts[lang as keyof typeof settings.fonts] || "serif"}
                  paragraphSpacing={settings.paragraphSpacing}
                  draggable={canDrag}
                  onDropLang={(fromLang, toLang) => swapLangs(fromLang, toLang)}
                />
              );
            })
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              {content ? "No paragraphs" : "Loading..."}
            </div>
          )}
        </div>
      </div>

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
          onClose={() => {
            setWordSelection(null);
            // Clear the browser selection so the user doesn't see stale highlights.
            window.getSelection()?.removeAllRanges();
          }}
        />
      )}
    </div>
  );
}
