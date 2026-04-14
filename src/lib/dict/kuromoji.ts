import path from "path";
import type { Tokenizer, IpadicFeatures } from "kuromoji";

/**
 * Kuromoji is expensive to initialize (~2-3s to read the 12MB dict files),
 * so we memoize a single promise for the lifetime of the Node process.
 * The dict files ship inside node_modules/kuromoji/dict.
 */
let _tokenizerPromise: Promise<Tokenizer<IpadicFeatures>> | null = null;

function getTokenizer(): Promise<Tokenizer<IpadicFeatures>> {
  if (_tokenizerPromise) return _tokenizerPromise;

  _tokenizerPromise = new Promise((resolve, reject) => {
    // Dynamic import because kuromoji is CommonJS-only and doesn't play nicely
    // with ESM top-level import in Next.js bundling.
    import("kuromoji")
      .then((mod) => {
        const kuromoji = (mod as unknown as { default: typeof import("kuromoji") }).default ?? mod;
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

/**
 * Tokenize a Japanese string and return the basic forms of each token.
 * For conjugated verbs/adjectives, basic_form is the dictionary form
 * ("行った" → "行く"). Tokens whose basic_form is "*" (unknown) fall
 * back to their surface form.
 */
export async function getBaseForms(query: string): Promise<string[]> {
  const tokenizer = await getTokenizer();
  const tokens = tokenizer.tokenize(query);
  const bases = new Set<string>();
  for (const t of tokens) {
    const base = t.basic_form && t.basic_form !== "*" ? t.basic_form : t.surface_form;
    if (base) bases.add(base);
  }
  return Array.from(bases);
}
