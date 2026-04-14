import type { DictFormatInfo, DictTargetLang } from "./types";

// ISO 639-3 codes JMdict uses, mapped back to our short codes.
const ISO_TO_SHORT: Record<string, DictTargetLang> = {
  eng: "en",
  zho: "zh",
  chi: "zh",
  ger: "de",
  deu: "de",
  fre: "fr",
  fra: "fr",
  rus: "ru",
  spa: "es",
  dut: "nl",
  nld: "nl",
  hun: "hu",
  slv: "sl",
  swe: "sv",
};

/**
 * Peek at the first ~4KB of a decompressed dictionary file and decide
 * whether it's JMdict (XML) or CC-CEDICT (line-based text). Returns null
 * if neither format matches.
 *
 * For JMdict we also scan the whole blob (cheap regex, no parse) to
 * discover which `xml:lang` codes appear, so the upload UI can offer
 * the right set of target-language choices for multi-lang files.
 */
export function detectDictFormat(sample: string): DictFormatInfo | null {
  const head = sample.slice(0, 4096);

  // JMdict XML — look for the root tag or DOCTYPE declaration.
  if (/<JMdict\b/.test(head) || /<!DOCTYPE\s+JMdict/.test(head)) {
    const langs = new Set<DictTargetLang>();
    // Any gloss with no xml:lang is English by JMdict convention.
    if (/<gloss>/.test(sample)) langs.add("en");
    const attrRegex = /<gloss\s[^>]*xml:lang\s*=\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = attrRegex.exec(sample)) !== null) {
      const short = ISO_TO_SHORT[m[1]];
      if (short) langs.add(short);
    }
    if (langs.size === 0) langs.add("en");
    return {
      format: "jmdict",
      sourceLang: "ja",
      suggestedName: "JMdict",
      availableTargetLangs: Array.from(langs),
    };
  }

  // CC-CEDICT — starts with `#` comment lines, then entries in the form
  // `traditional simplified [pinyin] /gloss/`.
  const cedictHeader = /^#\s*CC-CEDICT/m.test(head);
  const cedictLine = /^\S+\s+\S+\s+\[[^\]]+\]\s+\//m.test(head);
  if (cedictHeader || cedictLine) {
    return {
      format: "cedict",
      sourceLang: "zh",
      suggestedName: "CC-CEDICT",
      availableTargetLangs: ["en"],
    };
  }

  return null;
}
