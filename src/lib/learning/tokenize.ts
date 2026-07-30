import path from "path";
import type { Tokenizer, IpadicFeatures } from "kuromoji";

/**
 * Content-word tokenization for immersive reading (L3). Splits Japanese
 * text into spans worth tracking as vocabulary: nouns, verbs, adjectives,
 * adverbs and the like, each mapped to its dictionary form. Particles,
 * auxiliaries, punctuation, numbers, and dependent forms (いる after て,
 * こと, suffixes) are left as plain text — a learner shouldn't be asked
 * to "know" は or 。.
 *
 * Shares kuromoji's memoized tokenizer pattern with src/lib/dict/kuromoji
 * but keeps its own instance promise so either module can load first.
 */

export interface ContentToken {
  /** UTF-16 offset of the token inside the input string. */
  start: number;
  end: number;
  surface: string;
  lemma: string;
}

const CONTENT_POS = new Set([
  "名詞",
  "動詞",
  "形容詞",
  "副詞",
  "連体詞",
  "感動詞",
  "接続詞",
]);

// pos_detail_1 values that disqualify an otherwise-content token.
const EXCLUDED_DETAIL = new Set(["数", "非自立", "接尾", "サ変接続無し"]);

let _tokenizerPromise: Promise<Tokenizer<IpadicFeatures>> | null = null;

function getTokenizer(): Promise<Tokenizer<IpadicFeatures>> {
  if (_tokenizerPromise) return _tokenizerPromise;
  _tokenizerPromise = new Promise((resolve, reject) => {
    import("kuromoji")
      .then((mod) => {
        const kuromoji =
          (mod as unknown as { default: typeof import("kuromoji") }).default ?? mod;
        const dicPath = path.join(process.cwd(), "node_modules", "kuromoji", "dict");
        kuromoji.builder({ dicPath }).build((err, tokenizer) => {
          if (err) reject(err);
          else resolve(tokenizer);
        });
      })
      .catch(reject);
  });
  return _tokenizerPromise;
}

export function isContentToken(token: IpadicFeatures): boolean {
  if (!CONTENT_POS.has(token.pos)) return false;
  if (token.pos_detail_1 && EXCLUDED_DETAIL.has(token.pos_detail_1)) return false;
  // Whitespace-only or empty surfaces are never content.
  if (!token.surface_form || token.surface_form.trim() === "") return false;
  return true;
}

/** Tokenize one Japanese string into content-word spans. */
export async function tokenizeContentWords(text: string): Promise<ContentToken[]> {
  if (!text) return [];
  const tokenizer = await getTokenizer();
  const tokens = tokenizer.tokenize(text);
  const out: ContentToken[] = [];
  for (const t of tokens) {
    if (!isContentToken(t)) continue;
    // word_position is 1-based; kuromoji guarantees it indexes the input.
    const start = t.word_position - 1;
    const surface = t.surface_form;
    const lemma =
      t.basic_form && t.basic_form !== "*" ? t.basic_form : surface;
    out.push({ start, end: start + surface.length, surface, lemma });
  }
  return out;
}

/** Distinct lemma list for corpus indexing (paragraph_lemmas rows). */
export async function lemmasForText(text: string): Promise<string[]> {
  const tokens = await tokenizeContentWords(text);
  return Array.from(new Set(tokens.map((t) => t.lemma)));
}
