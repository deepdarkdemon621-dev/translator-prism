import {
  DEFAULT_LANG_ORDER,
  type ReaderLang,
} from "@/lib/reader/language-selection";

export type TerminalTranslation = {
  text: string | null;
  status: string;
  errorMessage?: string | null;
};

export type TerminalParagraph = {
  seq: number;
  kind: "text" | "image";
  sourceLang: string;
  sourceText: string;
  translations: Record<string, TerminalTranslation>;
};

type NormalizeTerminalLangsOptions = {
  requested?: string | null;
  sourceLang: string;
  availableLangs: readonly string[];
};

const READER_LANGS = new Set<string>(DEFAULT_LANG_ORDER);

function isReaderLang(value: string): value is ReaderLang {
  return READER_LANGS.has(value);
}

function pushUnique(langs: ReaderLang[], lang: ReaderLang): void {
  if (!langs.includes(lang)) langs.push(lang);
}

function formatLangLabel(lang: ReaderLang): string {
  return lang.toUpperCase().padEnd(3, " ");
}

export function normalizeTerminalLangs({
  requested,
  sourceLang,
  availableLangs,
}: NormalizeTerminalLangsOptions): ReaderLang[] {
  const source = isReaderLang(sourceLang) ? sourceLang : null;
  const available = new Set(
    availableLangs.filter((lang): lang is ReaderLang => isReaderLang(lang)),
  );
  const requestedValue = requested?.trim().toLowerCase();

  if (!requestedValue || requestedValue === "auto") {
    const normalized: ReaderLang[] = [];
    if (source) pushUnique(normalized, source);
    for (const lang of DEFAULT_LANG_ORDER) {
      if (lang !== source && available.has(lang)) pushUnique(normalized, lang);
    }
    return normalized.length > 0 ? normalized : [...DEFAULT_LANG_ORDER];
  }

  const normalized: ReaderLang[] = [];
  for (const part of requestedValue.split(",")) {
    const lang = part.trim().toLowerCase();
    if (!isReaderLang(lang)) continue;
    if (lang !== source && !available.has(lang)) continue;
    pushUnique(normalized, lang);
  }

  if (normalized.length > 0) return normalized;
  return source ? [source] : [...DEFAULT_LANG_ORDER];
}

export function stripHtmlForTerminal(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function renderParagraphBlock(
  paragraph: TerminalParagraph,
  langs: readonly ReaderLang[],
): string {
  if (paragraph.kind === "image") {
    return `[${paragraph.seq}]\nIMG [image]`;
  }

  const lines = [`[${paragraph.seq}]`];
  for (const lang of langs) {
    const label = formatLangLabel(lang);
    if (lang === paragraph.sourceLang) {
      lines.push(`${label} ${stripHtmlForTerminal(paragraph.sourceText)}`);
      continue;
    }

    const translation = paragraph.translations[lang];
    const text =
      translation?.status === "done" && translation.text
        ? stripHtmlForTerminal(translation.text)
        : `[${translation?.status ?? "missing"}]`;
    lines.push(`${label} ${text}`);
  }
  return lines.join("\n");
}

export function paginateParagraphs<T>(
  paragraphs: readonly T[],
  page: number,
  pageSize: number,
): T[] {
  const safePage = Math.max(0, Math.trunc(page));
  const start = safePage * pageSize;
  return paragraphs.slice(start, start + pageSize);
}
