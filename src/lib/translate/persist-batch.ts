import type { Client, InStatement } from "@libsql/client";
import { randomUUID } from "crypto";
import { sourceHash } from "./source-hash";

// Batched persistence for validated model output (ARCH-002). One
// client.batch(..., "write") call commits a whole result batch: per accepted
// item the attempt history and canonical translations row move together, and
// every statement is guarded by lease ownership so a row that was cancelled,
// reclaimed, or re-sourced mid-flight is skipped as a unit.

export interface PersistAcceptedItem {
  translationId: string;
  /** Claim-time source text; commits are refused if it changed since. */
  sourceText: string;
  text: string;
  model: string | null;
  provider: string | null;
  tokensUsed: number | null;
  warnings?: string[];
}

export interface PersistFailedItem {
  translationId: string;
  sourceText: string;
  /** Rejected model output, when there was any. */
  candidateText?: string;
  reasons?: string[];
  attemptStatus?: "rejected" | "failed";
  errorCode: string;
  errorMessage: string;
  provider: string | null;
  model: string | null;
}

export interface PersistBatchInput {
  client: Client;
  workerId: string;
  runId: string | null;
  promptVersion: string;
  reasoningEffort?: string | null;
  accepted: PersistAcceptedItem[];
  failed: PersistFailedItem[];
  now?: Date;
}

export interface PersistBatchResult {
  committedDone: string[];
  committedFailed: string[];
  /** Items skipped because the row was not ours anymore or the source moved. */
  skipped: string[];
}

// Ownership guard used by attempt statements: the canonical row must still be
// processing under our worker id, and for accepted items the paragraph source
// must be byte-identical to what the model translated.
const OWNED_FRESH_GUARD = `EXISTS (
  SELECT 1 FROM translations tg
  JOIN paragraphs pg ON pg.id = tg.paragraph_id
  WHERE tg.id = ? AND tg.status = 'processing' AND tg.claimed_by = ?
    AND pg.source_text = ?
)`;

export async function persistTranslationBatch(
  input: PersistBatchInput,
): Promise<PersistBatchResult> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const statements: InStatement[] = [];
  // Index of the canonical UPDATE for each item so rowsAffected can be
  // mapped back after the batch commits.
  const canonicalIndex: { translationId: string; index: number; kind: "done" | "failed" }[] = [];

  for (const item of input.accepted) {
    const hash = sourceHash(item.sourceText);
    statements.push({
      sql: `UPDATE translation_attempts
            SET is_active = 0,
                status = CASE WHEN status = 'accepted' THEN 'superseded' ELSE status END
            WHERE translation_id = ? AND is_active = 1 AND ${OWNED_FRESH_GUARD}`,
      args: [
        item.translationId,
        item.translationId,
        input.workerId,
        item.sourceText,
      ],
    });
    statements.push({
      sql: `INSERT INTO translation_attempts
              (id, translation_id, run_id, legacy_translation_id, provider,
               model, reasoning_effort, prompt_version, source_hash, text,
               status, quality_codes, error_message, tokens_used, is_active,
               created_at)
            SELECT ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'accepted', ?, NULL, ?, 1, ?
            WHERE ${OWNED_FRESH_GUARD}`,
      args: [
        randomUUID(),
        item.translationId,
        input.runId,
        item.provider,
        item.model,
        input.reasoningEffort ?? null,
        input.promptVersion,
        hash,
        item.text,
        item.warnings && item.warnings.length > 0
          ? JSON.stringify(item.warnings)
          : null,
        item.tokensUsed,
        nowIso,
        item.translationId,
        input.workerId,
        item.sourceText,
      ],
    });
    canonicalIndex.push({
      translationId: item.translationId,
      index: statements.length,
      kind: "done",
    });
    statements.push({
      sql: `UPDATE translations
            SET text = ?, status = 'done', model = ?, tokens_used = ?,
                error_message = NULL, last_provider = ?, last_error_code = NULL,
                claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'processing' AND claimed_by = ?
              AND EXISTS (
                SELECT 1 FROM paragraphs pg
                WHERE pg.id = translations.paragraph_id AND pg.source_text = ?
              )`,
      args: [
        item.text,
        item.model,
        item.tokensUsed,
        item.provider,
        nowIso,
        item.translationId,
        input.workerId,
        item.sourceText,
      ],
    });
  }

  for (const item of input.failed) {
    statements.push({
      sql: `INSERT INTO translation_attempts
              (id, translation_id, run_id, legacy_translation_id, provider,
               model, reasoning_effort, prompt_version, source_hash, text,
               status, quality_codes, error_message, tokens_used, is_active,
               created_at)
            SELECT ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?
            WHERE ${OWNED_FRESH_GUARD}`,
      args: [
        randomUUID(),
        item.translationId,
        input.runId,
        item.provider,
        item.model,
        input.reasoningEffort ?? null,
        input.promptVersion,
        sourceHash(item.sourceText),
        item.candidateText ?? "",
        item.attemptStatus ?? "failed",
        item.reasons && item.reasons.length > 0
          ? JSON.stringify(item.reasons)
          : null,
        item.errorMessage,
        nowIso,
        item.translationId,
        input.workerId,
        item.sourceText,
      ],
    });
    canonicalIndex.push({
      translationId: item.translationId,
      index: statements.length,
      kind: "failed",
    });
    statements.push({
      sql: `UPDATE translations
            SET status = 'failed', error_message = ?, last_provider = ?,
                last_error_code = ?, claimed_by = NULL, lease_expires_at = NULL,
                updated_at = ?
            WHERE id = ? AND status = 'processing' AND claimed_by = ?
              AND EXISTS (
                SELECT 1 FROM paragraphs pg
                WHERE pg.id = translations.paragraph_id AND pg.source_text = ?
              )`,
      args: [
        item.errorMessage,
        item.provider,
        item.errorCode,
        nowIso,
        item.translationId,
        input.workerId,
        item.sourceText,
      ],
    });
  }

  const result: PersistBatchResult = {
    committedDone: [],
    committedFailed: [],
    skipped: [],
  };
  if (statements.length === 0) return result;

  const outcomes = await input.client.batch(statements, "write");
  for (const entry of canonicalIndex) {
    const affected = Number(outcomes[entry.index]?.rowsAffected ?? 0);
    if (affected === 0) {
      result.skipped.push(entry.translationId);
    } else if (entry.kind === "done") {
      result.committedDone.push(entry.translationId);
    } else {
      result.committedFailed.push(entry.translationId);
    }
  }
  return result;
}
