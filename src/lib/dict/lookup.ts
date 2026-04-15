import { getLibsqlClient } from "@/lib/db";
import { getBaseForms } from "./kuromoji";

export interface DictLookupResult {
  dictionaryId: string;
  dictionaryName: string;
  // Source language of the dictionary this row came from — 'ja' | 'zh'.
  // UI uses it to render pronunciation hints and to keep cross-lookup rows
  // visually distinct (e.g. labelling a CEDICT hit as ZH pinyin when the
  // user was looking up a Japanese word with shared kanji).
  sourceLang: string;
  headword: string;
  reading: string;
  gloss: string;
}

// Unified CJK Ideographs + Extension A — good-enough detector for "this
// query shares kanji/hanzi shape and is worth trying against the other
// language's dictionaries too". Kana (hiragana/katakana) explicitly does
// NOT match, so pure-kana words don't spam CEDICT with useless queries.
const CJK_CHAR_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;
function hasCjkKanji(s: string): boolean {
  return CJK_CHAR_REGEX.test(s);
}

/**
 * Look up a word in all installed dictionaries for the given language.
 *
 * - For Japanese, we first tokenize with kuromoji to recover dictionary
 *   (basic) forms, then search by headword equality.
 * - For Chinese/English, we search on the raw input (optionally trimmed
 *   and lowercased for English).
 *
 * We use `headword = ?` equality against the FTS5 table because that's
 * what users want in 99% of cases. FTS5 fuzzy MATCH is overkill here and
 * produces noisier results.
 */
export async function lookupWord(params: {
  lang: string;
  query: string;
}): Promise<DictLookupResult[]> {
  const { lang } = params;
  const rawQuery = params.query.trim();
  if (!rawQuery) return [];

  // Build the list of candidate headwords to try.
  let candidates: string[] = [rawQuery];
  if (lang === "ja") {
    try {
      const bases = await getBaseForms(rawQuery);
      candidates = Array.from(new Set([rawQuery, ...bases]));
    } catch (err) {
      console.error("[dict] kuromoji failed, falling back to raw query:", err);
    }
  } else if (lang === "en") {
    candidates = [rawQuery.toLowerCase()];
  }

  const client = getLibsqlClient();

  // Primary lookup: dictionaries whose source_lang matches the query lang.
  // Cross-lookup: if the query contains CJK kanji/hanzi, also query the
  // OTHER language's dictionaries — a Japanese word like 自由 exists as
  // 自由 in CC-CEDICT with Chinese pinyin, and vice versa. This is our
  // poor-man's JA↔ZH bridge since no free JA→ZH dictionary exists.
  const isCjkQuery = hasCjkKanji(rawQuery);
  const crossLang = lang === "ja" ? "zh" : lang === "zh" ? "ja" : null;

  const primaryDictsRes = await client.execute({
    sql: "SELECT id, name, source_lang FROM dictionaries WHERE source_lang = ?",
    args: [lang],
  });
  const primaryDicts = primaryDictsRes.rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    source_lang: r.source_lang as string,
  }));

  let crossDicts: Array<{ id: string; name: string; source_lang: string }> = [];
  if (isCjkQuery && crossLang) {
    const crossRes = await client.execute({
      sql: "SELECT id, name, source_lang FROM dictionaries WHERE source_lang = ?",
      args: [crossLang],
    });
    crossDicts = crossRes.rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      source_lang: r.source_lang as string,
    }));
  }

  const dictRows = [...primaryDicts, ...crossDicts];
  if (dictRows.length === 0) return [];

  const dictIds = dictRows.map((d) => d.id);
  const dictMetaById = new Map(
    dictRows.map((d) => [d.id, { name: d.name, sourceLang: d.source_lang }]),
  );

  const placeholders = dictIds.map(() => "?").join(",");
  const selectSql = `SELECT dictionary_id, headword, reading, gloss
       FROM dict_entries
      WHERE dictionary_id IN (${placeholders}) AND headword = ?`;

  // Dedup on (dictionary_id, headword, gloss) so variant candidates don't
  // produce duplicate rows when they both resolve to the same entry.
  const seen = new Set<string>();
  const primaryResults: DictLookupResult[] = [];
  const crossResults: DictLookupResult[] = [];

  // Cross-lookup only uses the raw query as candidate — kuromoji's
  // Japanese base-forms aren't meaningful for Chinese dicts, and English
  // lowercasing doesn't apply.
  const primaryCandidates = candidates;
  const crossCandidates = isCjkQuery && crossLang ? [rawQuery] : [];

  const runLookup = async (
    candidateList: string[],
    dictIdSet: Set<string>,
    bucket: DictLookupResult[],
  ) => {
    for (const candidate of candidateList) {
      const res = await client.execute({
        sql: selectSql,
        args: [...dictIds, candidate],
      });
      for (const row of res.rows) {
        const dictionary_id = row.dictionary_id as string;
        if (!dictIdSet.has(dictionary_id)) continue;
        const headword = row.headword as string;
        const gloss = row.gloss as string;
        const reading = row.reading as string;
        const key = `${dictionary_id}::${headword}::${gloss}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const meta = dictMetaById.get(dictionary_id);
        bucket.push({
          dictionaryId: dictionary_id,
          dictionaryName: meta?.name ?? "",
          sourceLang: meta?.sourceLang ?? "",
          headword,
          reading,
          gloss,
        });
      }
    }
  };

  await runLookup(
    primaryCandidates,
    new Set(primaryDicts.map((d) => d.id)),
    primaryResults,
  );
  await runLookup(
    crossCandidates,
    new Set(crossDicts.map((d) => d.id)),
    crossResults,
  );

  // Primary hits come first; cross-dict hits appended so the popover
  // shows the "real" answer on top and the cross-reference as extra info.
  return [...primaryResults, ...crossResults];
}
