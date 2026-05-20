"use client";

import { useEffect, useRef } from "react";
import type { ReaderLang } from "@/lib/reader/language-selection";
import { ParagraphBlock } from "./ParagraphBlock";
import type { WordSelection } from "./WordLookupPopover";

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

interface MobileParagraphViewProps {
  sourceLang: string;
  visibleLangs: ReaderLang[];
  labels: Record<string, string>;
  paragraphs: Paragraph[];
  highlightedId: string | null;
  onParagraphClick: (id: string) => void;
  onActiveParagraphChange: (id: string) => void;
  onWordSelect?: (selection: WordSelection) => void;
  onRetryParagraph?: (paragraphId: string) => void;
  retryingIds?: Set<string>;
  fontSize: number;
  lineHeight: number;
  fonts: Record<ReaderLang, string>;
  paragraphSpacing: "compact" | "standard" | "relaxed";
}

const SPACING_CLASS: Record<"compact" | "standard" | "relaxed", string> = {
  compact: "mb-3",
  standard: "mb-5",
  relaxed: "mb-8",
};

const MAX_SELECTION_LENGTH = 50;

export function MobileParagraphView({
  sourceLang,
  visibleLangs,
  labels,
  paragraphs,
  highlightedId,
  onParagraphClick,
  onActiveParagraphChange,
  onWordSelect,
  onRetryParagraph,
  retryingIds,
  fontSize,
  lineHeight,
  fonts,
  paragraphSpacing,
}: MobileParagraphViewProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const id = visible[0]?.target.getAttribute("data-reader-paragraph-id");
        if (id) onActiveParagraphChange(id);
      },
      { root, threshold: 0.2 },
    );

    const nodes = root.querySelectorAll("[data-reader-paragraph-id]");
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [onActiveParagraphChange, paragraphs, visibleLangs]);

  const handleMouseUp = (lang: string) => {
    if (lang !== sourceLang || !onWordSelect) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const word = sel.toString().trim();
    if (word.length === 0 || word.length > MAX_SELECTION_LENGTH) return;

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    let node: Node | null = range.startContainer;
    while (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentNode;
    let paragraphEl: HTMLElement | null = node as HTMLElement | null;
    while (paragraphEl && paragraphEl.tagName !== "P") {
      paragraphEl = paragraphEl.parentElement;
    }
    const contextText = paragraphEl?.textContent?.trim() ?? "";
    onWordSelect({ word, lang, rect, contextText });
  };

  return (
    <div
      ref={scrollerRef}
      className="flex-1 overflow-y-auto px-4 py-5 animate-in fade-in duration-500"
    >
      <div className="max-w-[42rem] mx-auto">
        {paragraphs.map((p) => {
          if (p.kind === "image") {
            const src = p.sourceMarkup.match(/src="([^"]+)"/)?.[1];
            return (
              <div
                key={p.id}
                className={SPACING_CLASS[paragraphSpacing]}
                data-reader-paragraph-id={p.id}
              >
                {src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={src} alt={p.sourceText} className="block mx-auto max-w-full h-auto" loading="lazy" />
                ) : null}
              </div>
            );
          }

          return (
            <div
              key={p.id}
              className={`${SPACING_CLASS[paragraphSpacing]} rounded-lg ${
                highlightedId === p.id ? "bg-primary/5" : ""
              }`}
              data-reader-paragraph-id={p.id}
            >
              {visibleLangs.map((lang) => {
                const isSource = lang === sourceLang;
                const text = isSource ? p.sourceText : p.translations[lang]?.text || "";
                const status = isSource ? "done" : p.translations[lang]?.status || "pending";
                const errorMessage = isSource ? null : p.translations[lang]?.errorMessage ?? null;
                return (
                  <div key={lang} className="mb-2 last:mb-0" onMouseUp={() => handleMouseUp(lang)}>
                    <div className="px-4 mb-1 text-[10px] text-muted-foreground uppercase tracking-[0.18em] font-sans font-medium">
                      {labels[lang] || lang}
                    </div>
                    <ParagraphBlock
                      id={p.id}
                      text={text}
                      isHighlighted={highlightedId === p.id}
                      onClick={onParagraphClick}
                      fontSize={fontSize}
                      lineHeight={lineHeight}
                      fontFamily={fonts[lang]}
                      status={status}
                      errorMessage={errorMessage}
                      onRetry={isSource ? undefined : onRetryParagraph}
                      retrying={retryingIds?.has(p.id)}
                      lang={lang}
                      showTts
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
