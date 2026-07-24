import { CliOutputError } from "./cli-output";
import type { ChapterBatchRequest, TranslationBatchResult } from "./types";

// Per-item validation for chapter batch output (ARCH-002). Two levels:
// hard rejections for output that must never reach the canonical row, and
// warnings for heuristic signals. Heuristics stay conservative — for literary
// text a false rejection is worse than a review warning.

export interface ExpectedBatchItem {
  id: string;
  sourceText: string;
}

export interface BatchValidationInput {
  expected: ExpectedBatchItem[];
  results: { id: string; text: string; tokensUsed?: number; model?: string }[];
  sourceLang: string;
  targetLang: string;
}

export interface AcceptedBatchItem {
  id: string;
  text: string;
  warnings: string[];
  tokensUsed?: number;
  model?: string;
}

export interface RejectedBatchItem {
  id: string;
  text: string;
  reasons: string[];
}

export interface BatchValidationResult {
  accepted: AcceptedBatchItem[];
  rejected: RejectedBatchItem[];
  /** Expected ids with no usable result; retryable in a smaller batch. */
  missing: string[];
  /** Returned ids that were never requested; dropped. */
  unknown: string[];
}

const KANA_RE = /[ぁ-ゖァ-ヺ]/;
// "Meaningful" characters: anything beyond punctuation/digits/whitespace.
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

const EXPLANATORY_PREFIX_RE =
  /^(here (is|are)\b|sure[,!:]|certainly[,!:]|以下是|以下为|译文[::]|翻译[::]|翻訳[::])/i;
const REFUSAL_RE =
  /\b(i can(?:no|')t|i cannot|i'?m sorry|i am sorry|as an ai)\b|申し訳ありません|无法翻译|不能翻译/i;

function normalize(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function validateItem(
  text: string,
  sourceText: string,
  sourceLang: string,
): { reasons: string[]; warnings: string[] } {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const trimmed = text.trim();

  if (trimmed === "") {
    return { reasons: ["empty_text"], warnings };
  }
  if (/^```|```$/.test(trimmed)) {
    reasons.push("markdown_fence");
  }
  if (EXPLANATORY_PREFIX_RE.test(trimmed)) {
    reasons.push("explanatory_prefix");
  }
  if (REFUSAL_RE.test(trimmed.slice(0, 120))) {
    reasons.push("refusal");
  }

  const normalizedSource = normalize(sourceText);
  const normalizedText = normalize(trimmed);
  if (normalizedText === normalizedSource) {
    // Identical output is only a definite failure when the source visibly
    // needed translating: Japanese kana never survives a correct ja->zh/en
    // translation. Kanji-only names and punctuation/number-only lines can
    // legitimately be identical, so they warn (or pass) instead.
    const hasWordChars = WORD_CHAR_RE.test(normalizedSource);
    if (sourceLang === "ja" && KANA_RE.test(normalizedSource)) {
      reasons.push("source_copy");
    } else if (hasWordChars) {
      warnings.push("source_copy");
    }
    return { reasons, warnings };
  }

  // Length-ratio heuristic on longer sources only; short lines vary wildly.
  if (normalizedSource.length >= 20) {
    const ratio = normalizedText.length / normalizedSource.length;
    if (ratio < 0.15 || ratio > 6) {
      warnings.push("length_ratio");
    }
  }

  // Residual source-script heuristic: kana surviving into the target text.
  if (sourceLang === "ja" && KANA_RE.test(normalizedText)) {
    warnings.push("residual_source_script");
  }

  return { reasons, warnings };
}

export function validateBatchResults(
  input: BatchValidationInput,
): BatchValidationResult {
  const expectedById = new Map(input.expected.map((item) => [item.id, item]));

  const unknown: string[] = [];
  const counts = new Map<string, number>();
  for (const result of input.results) {
    if (!expectedById.has(result.id)) {
      unknown.push(result.id);
      continue;
    }
    counts.set(result.id, (counts.get(result.id) ?? 0) + 1);
  }

  const accepted: AcceptedBatchItem[] = [];
  const rejected: RejectedBatchItem[] = [];
  const seen = new Set<string>();

  for (const result of input.results) {
    const expected = expectedById.get(result.id);
    if (!expected) continue;
    if (seen.has(result.id)) continue;
    seen.add(result.id);

    // A duplicated id means the model lost track of the mapping; neither
    // candidate can be trusted.
    if ((counts.get(result.id) ?? 0) > 1) {
      rejected.push({ id: result.id, text: result.text, reasons: ["duplicate_id"] });
      continue;
    }

    const { reasons, warnings } = validateItem(
      result.text,
      expected.sourceText,
      input.sourceLang,
    );
    if (reasons.length > 0) {
      rejected.push({ id: result.id, text: result.text, reasons });
    } else {
      accepted.push({
        id: result.id,
        text: result.text.trim(),
        warnings,
        tokensUsed: result.tokensUsed,
        model: result.model,
      });
    }
  }

  const missing = input.expected
    .filter((item) => !seen.has(item.id))
    .map((item) => item.id);

  return { accepted, rejected, missing, unknown };
}

export interface SplitRetryFailure {
  id: string;
  code: "invalid_output";
  message: string;
}

export interface SplitRetryOutcome {
  results: TranslationBatchResult[];
  failures: SplitRetryFailure[];
}

/**
 * Run a chapter batch with bounded binary-split retry. Only whole-batch parse
 * failures (CliOutputError) split; other errors (timeout, auth, quota…)
 * propagate for normal provider-chain/executor classification. There is no
 * implicit provider fallback here. Groups still failing at one item or at
 * maxDepth are recorded as invalid_output failures.
 */
export async function runBatchWithSplitRetry(
  request: ChapterBatchRequest,
  translateBatch: (request: ChapterBatchRequest) => Promise<TranslationBatchResult[]>,
  opts: { maxDepth?: number } = {},
): Promise<SplitRetryOutcome> {
  const maxDepth = opts.maxDepth ?? 4;
  const results: TranslationBatchResult[] = [];
  const failures: SplitRetryFailure[] = [];

  async function run(items: ChapterBatchRequest["items"], depth: number): Promise<void> {
    try {
      results.push(...(await translateBatch({ ...request, items })));
      return;
    } catch (err) {
      if (!(err instanceof CliOutputError)) throw err;
      if (items.length === 1 || depth >= maxDepth) {
        for (const item of items) {
          failures.push({ id: item.id, code: "invalid_output", message: err.message });
        }
        return;
      }
      const mid = Math.ceil(items.length / 2);
      await run(items.slice(0, mid), depth + 1);
      await run(items.slice(mid), depth + 1);
    }
  }

  await run(request.items, 0);
  return { results, failures };
}
