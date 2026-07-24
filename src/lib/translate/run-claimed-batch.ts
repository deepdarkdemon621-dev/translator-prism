import type { Client } from "@libsql/client";
import { CliOutputError } from "@/lib/llm/cli-output";
import { ProviderChainError } from "@/lib/llm/provider-chain";
import {
  runBatchWithSplitRetry,
  validateBatchResults,
} from "@/lib/llm/translation-validation";
import type {
  ChapterBatchRequest,
  LLMProvider,
  TranslationBatchResult,
} from "@/lib/llm/types";
import { classifyTranslationFailure, getResultProviderName } from "@/lib/llm/executor";
import { formatErrorMessage } from "@/lib/llm/errors";
import { refreshChaptersStatus } from "@/lib/chapter-status";
import {
  persistTranslationBatch,
  type PersistAcceptedItem,
  type PersistFailedItem,
} from "./persist-batch";
import { releaseClaims, type ClaimedBatch } from "../../../worker/claim";

// One claimed chapter/language batch through the full ARCH-002 pipeline:
// provider request -> bounded split retry -> per-item validation -> one
// batched Turso write -> grouped chapter refresh. Valid items commit even
// when siblings are rejected or missing.

export interface RunClaimedBatchOptions {
  client: Client;
  provider: LLMProvider;
  batch: ClaimedBatch;
  workerId: string;
  runId: string | null;
  promptVersion: string;
  reasoningEffort?: string | null;
  maxSplitDepth?: number;
}

export interface RunClaimedBatchResult {
  done: number;
  failed: number;
  /** Items skipped by persistence guards (lost lease, stale source, cancel). */
  skipped: number;
  /** Missing items returned to the pending queue for a smaller retry batch. */
  released: number;
}

export async function runClaimedTranslationBatch(
  opts: RunClaimedBatchOptions,
): Promise<RunClaimedBatchResult> {
  const { batch } = opts;
  const request: ChapterBatchRequest = {
    bookTitle: batch.bookTitle,
    chapterTitle: batch.chapterTitle,
    sourceLang: batch.sourceLang,
    targetLang: batch.lang,
    items: batch.items.map((item) => ({
      id: item.translationId,
      seq: item.seq,
      text: item.sourceText,
    })),
  };
  const sourceTextById = new Map(
    batch.items.map((item) => [item.translationId, item.sourceText]),
  );

  const callBatch = async (
    req: ChapterBatchRequest,
  ): Promise<TranslationBatchResult[]> => {
    try {
      if (opts.provider.translateBatch) {
        return await opts.provider.translateBatch(req);
      }
      const out: TranslationBatchResult[] = [];
      for (const item of req.items) {
        const result = await opts.provider.translate(
          item.text,
          req.sourceLang,
          req.targetLang,
        );
        out.push({ ...result, id: item.id });
      }
      return out;
    } catch (err) {
      // A provider chain wraps parse failures in ProviderChainError; surface
      // them as CliOutputError so the bounded split retry can react. All
      // other errors (timeout, auth, quota…) propagate unchanged.
      if (err instanceof ProviderChainError && err.finalCode === "invalid_output") {
        throw new CliOutputError(err.message);
      }
      throw err;
    }
  };

  let outcome;
  try {
    outcome = await runBatchWithSplitRetry(request, callBatch, {
      maxDepth: opts.maxSplitDepth,
    });
  } catch (err) {
    // Non-parse failure: the whole batch fails with a classified code, same
    // as the legacy executor path.
    const classified = classifyTranslationFailure(err);
    const chainError = err instanceof ProviderChainError ? err : null;
    const failed: PersistFailedItem[] = batch.items.map((item) => ({
      translationId: item.translationId,
      sourceText: item.sourceText,
      errorCode: classified.code,
      errorMessage: formatErrorMessage(classified),
      provider: chainError?.finalProvider ?? opts.provider.name,
      model: null,
      attemptStatus: "failed",
    }));
    const persisted = await persistTranslationBatch({
      client: opts.client,
      workerId: opts.workerId,
      runId: opts.runId,
      promptVersion: opts.promptVersion,
      reasoningEffort: opts.reasoningEffort,
      accepted: [],
      failed,
    });
    await refreshChaptersStatus(opts.client, [batch.chapterId]);
    return {
      done: 0,
      failed: persisted.committedFailed.length,
      skipped: persisted.skipped.length,
      released: 0,
    };
  }

  const validation = validateBatchResults({
    expected: batch.items.map((item) => ({
      id: item.translationId,
      sourceText: item.sourceText,
    })),
    results: outcome.results,
    sourceLang: batch.sourceLang,
    targetLang: batch.lang,
  });

  const accepted: PersistAcceptedItem[] = validation.accepted.map((item) => ({
    translationId: item.id,
    sourceText: sourceTextById.get(item.id) ?? "",
    text: item.text,
    model: item.model ?? null,
    provider: getResultProviderName(item.model ?? null, opts.provider.name),
    tokensUsed: item.tokensUsed ?? null,
    warnings: item.warnings,
  }));

  const failed: PersistFailedItem[] = [];
  for (const item of validation.rejected) {
    failed.push({
      translationId: item.id,
      sourceText: sourceTextById.get(item.id) ?? "",
      candidateText: item.text,
      reasons: item.reasons,
      attemptStatus: "rejected",
      errorCode: "invalid_output",
      errorMessage: `[invalid_output] rejected: ${item.reasons.join(", ")}`,
      provider: opts.provider.name,
      model: null,
    });
  }
  const splitFailureIds = new Set<string>();
  for (const failure of outcome.failures) {
    splitFailureIds.add(failure.id);
    failed.push({
      translationId: failure.id,
      sourceText: sourceTextById.get(failure.id) ?? "",
      attemptStatus: "failed",
      errorCode: "invalid_output",
      errorMessage: `[invalid_output] ${failure.message.slice(0, 200)}`,
      provider: opts.provider.name,
      model: null,
    });
  }

  // Missing items: with siblings in flight, return them to the queue so the
  // next claim retries them in a smaller batch. A single-item batch that
  // still gets no result would loop forever — fail it instead.
  const missing = validation.missing.filter((id) => !splitFailureIds.has(id));
  const releasable: string[] = [];
  for (const id of missing) {
    if (batch.items.length === 1) {
      failed.push({
        translationId: id,
        sourceText: sourceTextById.get(id) ?? "",
        attemptStatus: "failed",
        errorCode: "invalid_output",
        errorMessage: "[invalid_output] model returned no result for this item",
        provider: opts.provider.name,
        model: null,
      });
    } else {
      releasable.push(id);
    }
  }

  const persisted = await persistTranslationBatch({
    client: opts.client,
    workerId: opts.workerId,
    runId: opts.runId,
    promptVersion: opts.promptVersion,
    reasoningEffort: opts.reasoningEffort,
    accepted,
    failed,
  });

  let released = 0;
  if (releasable.length > 0) {
    released = await releaseClaims({
      client: opts.client,
      workerId: opts.workerId,
      translationIds: releasable,
    });
  }

  await refreshChaptersStatus(opts.client, [batch.chapterId]);

  return {
    done: persisted.committedDone.length,
    failed: persisted.committedFailed.length,
    skipped: persisted.skipped.length,
    released,
  };
}
