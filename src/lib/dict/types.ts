export interface ParsedDictEntry {
  headword: string;
  reading: string;
  gloss: string;
}

export type DictFormat = "cedict" | "jmdict";
export type DictSourceLang = "ja" | "zh";
// Target language of the glosses. CC-CEDICT is always 'en'; JMdict_e is
// 'en'; JMdict multi-lang can emit 'en' / 'zh' / 'de' / ... variants.
export type DictTargetLang = "en" | "zh" | "de" | "fr" | "ru" | "es" | "nl" | "hu" | "sl" | "sv";

export interface DictFormatInfo {
  format: DictFormat;
  sourceLang: DictSourceLang;
  suggestedName: string;
  // Languages available in the file. JMdict_e reports ['en']; the multi-
  // lang distribution returns every code it saw in the first 4KB sample.
  availableTargetLangs: DictTargetLang[];
}
