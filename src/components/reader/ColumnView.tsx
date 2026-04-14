"use client";

import { ParagraphBlock } from "./ParagraphBlock";
import type { WordSelection } from "./WordLookupPopover";

interface Paragraph {
  id: string;
  seq: number;
  sourceText: string;
  translations: Record<
    string,
    { text: string | null; status: string; errorMessage?: string | null }
  >;
}

const SPACING_CLASS: Record<"compact" | "standard" | "relaxed", string> = {
  compact: "mb-2",
  standard: "mb-4",
  relaxed: "mb-8",
};

interface ColumnViewProps {
  lang: string;
  label: string;
  sourceLang: string;
  paragraphs: Paragraph[];
  highlightedId: string | null;
  onParagraphClick: (id: string) => void;
  onWordSelect?: (selection: WordSelection) => void;
  onRetryParagraph?: (paragraphId: string) => void;
  retryingIds?: Set<string>;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  paragraphSpacing: "compact" | "standard" | "relaxed";
  // Drag-reorder: only non-source target columns are draggable. When set,
  // the header becomes a drag handle; ReaderLayout owns the swap logic.
  draggable?: boolean;
  onDragStartLang?: (lang: string) => void;
  // Fires when a column header is dropped onto this column. `fromLang`
  // is the dragged column's lang (source of the swap), `toLang` is this
  // column's own lang. Caller swaps them in the prefs order.
  onDropLang?: (fromLang: string, toLang: string) => void;
}

const MAX_SELECTION_LENGTH = 50;

export function ColumnView({
  lang,
  label,
  sourceLang,
  paragraphs,
  highlightedId,
  onParagraphClick,
  onWordSelect,
  onRetryParagraph,
  retryingIds,
  fontSize,
  lineHeight,
  fontFamily,
  paragraphSpacing,
  draggable = false,
  onDragStartLang,
  onDropLang,
}: ColumnViewProps) {
  const isSourceColumn = lang === sourceLang;

  const handleMouseUp = () => {
    if (!isSourceColumn || !onWordSelect) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const word = sel.toString().trim();
    if (word.length === 0 || word.length > MAX_SELECTION_LENGTH) return;

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    // Walk up from the selection start to the nearest <p> so we can capture
    // the paragraph text as context for the vocabulary entry.
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
      className="flex-1 px-8 py-8 overflow-y-auto animate-in fade-in duration-500"
      onMouseUp={handleMouseUp}
    >
      <div
        className={`text-center text-[10px] text-muted-foreground uppercase tracking-[0.22em] mb-6 font-sans font-medium select-none ${
          draggable ? "cursor-grab active:cursor-grabbing hover:text-foreground" : ""
        }`}
        draggable={draggable}
        onDragStart={
          draggable
            ? (e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/x-reader-lang", lang);
                onDragStartLang?.(lang);
              }
            : undefined
        }
        onDragOver={
          draggable
            ? (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }
            : undefined
        }
        onDrop={
          draggable
            ? (e) => {
                e.preventDefault();
                // Only accept drops from our own drag source.
                const src = e.dataTransfer.getData("text/x-reader-lang");
                if (src && src !== lang) onDropLang?.(src, lang);
              }
            : undefined
        }
        title={draggable ? "Drag to swap with another language column" : undefined}
      >
        {draggable && <span className="opacity-50 mr-1">⇅</span>}
        {label}
      </div>
      <div className="max-w-[42rem] mx-auto">
        {paragraphs.map((p) => {
          const isSource = lang === sourceLang;
          const text = isSource
            ? p.sourceText
            : p.translations[lang]?.text || "";
          const status = isSource ? "done" : p.translations[lang]?.status || "pending";
          const errorMessage = isSource ? null : p.translations[lang]?.errorMessage ?? null;

          return (
            <div key={p.id} className={SPACING_CLASS[paragraphSpacing]}>
              <ParagraphBlock
                id={p.id}
                text={text}
                isHighlighted={highlightedId === p.id}
                onClick={onParagraphClick}
                fontSize={fontSize}
                lineHeight={lineHeight}
                fontFamily={fontFamily}
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
    </div>
  );
}
