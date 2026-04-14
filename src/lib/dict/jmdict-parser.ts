import type { ParsedDictEntry } from "./types";

/**
 * JMdict entry structure (simplified):
 *   <entry>
 *     <ent_seq>1000000</ent_seq>
 *     <k_ele><keb>行く</keb></k_ele>        -- kanji form(s), optional
 *     <r_ele><reb>いく</reb></r_ele>        -- reading form(s), at least one
 *     <sense>
 *       <pos>&v5k-s;</pos>
 *       <gloss>to go</gloss>                 -- default-lang (English)
 *       <gloss xml:lang="zho">去</gloss>    -- multi-lang dist: explicit
 *     </sense>
 *   </entry>
 *
 * We emit one entry per headword (kanji form, or reading if no kanji).
 * The same word may appear multiple times when it has multiple kanji
 * variants (e.g. 行く and 往く) — each gets its own FTS5 row so lookups
 * work regardless of which form the user selected.
 *
 * `targetLang` filters which <gloss> elements count:
 *   - 'en': accept glosses with no xml:lang attribute OR xml:lang="eng"
 *   - other BCP-47 codes: accept only the mapped ISO 639-3 codes
 * An entry whose senses have no matching-language glosses is skipped.
 * This is what lets the same JMdict_all.xml blob install as a separate
 * ja→zh, ja→de, ... dictionary without polluting each other.
 *
 * Parsing strategy: we load the whole XML blob into memory (~30MB for
 * JMdict_e, ~80MB for multi-lang), split on `</entry>`, and pick data
 * out of each chunk with targeted regexes. This avoids the memory cost
 * of a full DOM tree while still being simple to reason about.
 */

const KEB_REGEX = /<keb>([^<]+)<\/keb>/g;
const REB_REGEX = /<reb>([^<]+)<\/reb>/g;
const GLOSS_REGEX = /<gloss(\s[^>]*)?>([^<]+)<\/gloss>/g;
const XML_LANG_REGEX = /xml:lang\s*=\s*"([^"]+)"/;
const ENTRY_OPEN = "<entry>";

// Map short BCP-47-ish codes (the rest of our codebase speaks these — 'ja',
// 'zh', 'en') to JMdict's ISO 639-3 codes. Glosses with no xml:lang attribute
// are conventionally English; keep that as a special case.
const LANG_CODE_MAP: Record<string, string[]> = {
  en: ["eng"],
  zh: ["zho", "chi"],
  de: ["ger", "deu"],
  fr: ["fre", "fra"],
  ru: ["rus"],
  es: ["spa"],
  nl: ["dut", "nld"],
  hu: ["hun"],
  sl: ["slv"],
  sv: ["swe"],
};

export type JMdictTargetLang = keyof typeof LANG_CODE_MAP;

function extractAllText(source: string, regex: RegExp): string[] {
  const results: string[] = [];
  let match: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((match = regex.exec(source)) !== null) {
    results.push(decodeXmlEntities(match[1].trim()));
  }
  return results;
}

function extractGlossesForLang(source: string, targetLang: string): string[] {
  const allowed = LANG_CODE_MAP[targetLang] ?? [];
  const results: string[] = [];
  let match: RegExpExecArray | null;
  GLOSS_REGEX.lastIndex = 0;
  while ((match = GLOSS_REGEX.exec(source)) !== null) {
    const attrs = match[1] || "";
    const content = decodeXmlEntities(match[2].trim());
    const langMatch = attrs.match(XML_LANG_REGEX);
    const langCode = langMatch?.[1];
    if (!langCode) {
      // JMdict's default-lang convention: absence of xml:lang == English.
      if (targetLang === "en") results.push(content);
    } else if (allowed.includes(langCode)) {
      results.push(content);
    }
  }
  return results;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseJMdictEntry(
  entryXml: string,
  targetLang: string = "en",
): ParsedDictEntry[] {
  const kanjiForms = extractAllText(entryXml, KEB_REGEX);
  const readings = extractAllText(entryXml, REB_REGEX);
  const glosses = extractGlossesForLang(entryXml, targetLang);

  if (glosses.length === 0) return [];

  const gloss = glosses.join("; ");
  const reading = readings[0] ?? "";
  // If there are kanji forms, each is a lookup key. Otherwise the reading
  // itself is the headword (e.g. pure kana words like こんにちは).
  const headwords = kanjiForms.length > 0 ? kanjiForms : readings;

  return headwords.map((headword) => ({ headword, reading, gloss }));
}

export function* parseJMdict(
  xml: string,
  targetLang: string = "en",
): Generator<ParsedDictEntry> {
  const chunks = xml.split("</entry>");
  for (const chunk of chunks) {
    const start = chunk.indexOf(ENTRY_OPEN);
    if (start === -1) continue;
    const entryXml = chunk.slice(start + ENTRY_OPEN.length);
    for (const entry of parseJMdictEntry(entryXml, targetLang)) {
      yield entry;
    }
  }
}
