"use client";

interface ParagraphBlockProps {
  id: string;
  text: string;
  isHighlighted: boolean;
  onClick: (id: string) => void;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  status?: string;
  errorMessage?: string | null;
  onRetry?: (paragraphId: string) => void;
  retrying?: boolean;
  lang?: string;
  showTts?: boolean;
}

const LANG_VOICE: Record<string, string> = { ja: "ja-JP", zh: "zh-CN", en: "en-US" };

function speakText(text: string, lang: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = LANG_VOICE[lang] || lang;
  u.rate = 0.9;
  window.speechSynthesis.speak(u);
}

export function ParagraphBlock({
  id,
  text,
  isHighlighted,
  onClick,
  fontSize,
  lineHeight,
  fontFamily,
  status,
  errorMessage,
  onRetry,
  retrying,
  lang,
  showTts,
}: ParagraphBlockProps) {
  const isLoading = status === "processing" || status === "pending";
  const isFailed = status === "failed";

  if (isFailed) {
    return (
      <div
        className={`px-3 py-2 rounded border border-destructive/40 bg-destructive/5 ${
          isHighlighted ? "border-l-[3px] border-l-primary" : ""
        }`}
        style={{ fontSize: `${fontSize}px`, lineHeight, fontFamily }}
        onClick={() => onClick(id)}
      >
        <div className="text-destructive text-sm font-sans flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="font-medium">Translation failed</div>
            {errorMessage && (
              <div className="text-xs text-destructive/80 mt-0.5 break-words">
                {errorMessage}
              </div>
            )}
          </div>
          {onRetry && (
            <button
              type="button"
              disabled={retrying}
              onClick={(e) => {
                e.stopPropagation();
                onRetry(id);
              }}
              className="text-xs px-2 py-1 rounded border border-destructive/40 hover:bg-destructive/10 disabled:opacity-50 shrink-0"
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <p
      className={`group relative px-4 py-2 rounded-md cursor-pointer transition-all duration-300 ease-out ${
        isHighlighted
          ? "bg-primary/10 ring-1 ring-primary/20"
          : "hover:bg-muted/40"
      } ${isLoading ? "opacity-60" : ""}`}
      style={{ fontSize: `${fontSize}px`, lineHeight, fontFamily }}
      onClick={() => onClick(id)}
    >
      {isHighlighted && (
        <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-primary" />
      )}
      {isLoading ? (
        <span className="inline-block text-muted-foreground italic animate-pulse">
          Translating…
        </span>
      ) : (
        <>
          {text}
          {showTts && lang && text && (
            <button
              onClick={(e) => { e.stopPropagation(); speakText(text, lang); }}
              className="inline-flex items-center ml-1.5 align-middle text-muted-foreground/50 hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
              aria-label="Read aloud"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
            </button>
          )}
        </>
      )}
    </p>
  );
}
