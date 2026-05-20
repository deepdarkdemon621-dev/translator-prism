export type ReaderLang = "ja" | "zh" | "en";

export const DEFAULT_LANG_ORDER: ReaderLang[] = ["ja", "zh", "en"];

const LANG_SET = new Set<ReaderLang>(DEFAULT_LANG_ORDER);

function isReaderLang(value: unknown): value is ReaderLang {
  return typeof value === "string" && LANG_SET.has(value as ReaderLang);
}

export function normalizeLangOrder(value: unknown): ReaderLang[] {
  if (
    Array.isArray(value) &&
    value.length === DEFAULT_LANG_ORDER.length &&
    DEFAULT_LANG_ORDER.every((lang) => value.includes(lang))
  ) {
    return value as ReaderLang[];
  }
  return DEFAULT_LANG_ORDER;
}

export function normalizeVisibleLangs(
  value: unknown,
  langOrder: ReaderLang[],
): ReaderLang[] {
  if (!Array.isArray(value)) return [...langOrder];

  const selected = new Set<ReaderLang>();
  for (const lang of value) {
    if (isReaderLang(lang)) selected.add(lang);
  }

  if (selected.size === 0) return [...langOrder];
  return langOrder.filter((lang) => selected.has(lang));
}

export function toggleVisibleLang(
  current: ReaderLang[],
  lang: ReaderLang,
  langOrder: ReaderLang[],
): ReaderLang[] {
  const selected = new Set(current);
  if (selected.has(lang)) {
    if (selected.size === 1) return current;
    selected.delete(lang);
  } else {
    selected.add(lang);
  }
  return langOrder.filter((orderedLang) => selected.has(orderedLang));
}

export function orderVisibleLangs(
  visibleLangs: ReaderLang[],
  langOrder: ReaderLang[],
  sourceLang: string,
): ReaderLang[] {
  const ordered = langOrder.filter((lang) => visibleLangs.includes(lang));
  if (!LANG_SET.has(sourceLang as ReaderLang)) return ordered;

  const source = sourceLang as ReaderLang;
  if (!ordered.includes(source)) return ordered;
  return [source, ...ordered.filter((lang) => lang !== source)];
}
