import type { Client, InStatement } from "@libsql/client";
import { randomUUID } from "crypto";
import { sourceHash } from "@/lib/translate/source-hash";

// ARCH-002 integrity tooling. Classifies duplicate (paragraph_id, lang)
// translation groups and produces a deterministic report plus a conflict
// decisions skeleton. Everything in this file that touches the database is
// read-only; controlled cleanup lives behind scripts/dedupe-translations.ts.

export interface DuplicateCandidate {
  id: string;
  paragraphId: string;
  lang: string;
  status: string;
  text: string;
  model: string | null;
  lastProvider: string | null;
  errorMessage: string | null;
  tokensUsed: number | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  /** Current paragraph source text; used by dedupe archival hashes. */
  sourceText?: string;
}

export type DuplicateShape = "no_done" | "one_done" | "identical_done" | "conflict";

export interface CandidateSummary {
  id: string;
  status: string;
  textLength: number;
  model: string | null;
  lastProvider: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  /** Full text is included only for conflict groups so a human can decide. */
  text?: string;
}

export interface DuplicateGroupReport {
  paragraphId: string;
  lang: string;
  shape: DuplicateShape;
  conflict: boolean;
  survivorId: string | null;
  candidates: CandidateSummary[];
}

export interface IntegrityReport {
  generatedAt: string;
  totals: {
    duplicateGroups: number;
    extraRows: number;
    byShape: Partial<Record<DuplicateShape, number>>;
    byLang: Record<string, number>;
  };
  groups: DuplicateGroupReport[];
}

export interface ConflictDecision {
  paragraphId: string;
  lang: string;
  candidateIds: string[];
  survivorId: string | null;
}

export interface ConflictDecisionsFile {
  groups: ConflictDecision[];
}

/** A candidate counts as completed only when done with non-empty text. */
export function isCompletedCandidate(candidate: DuplicateCandidate): boolean {
  return candidate.status === "done" && candidate.text.trim() !== "";
}

function byOldest(a: DuplicateCandidate, b: DuplicateCandidate): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function byNewestMetadata(a: DuplicateCandidate, b: DuplicateCandidate): number {
  return (
    b.updatedAt.localeCompare(a.updatedAt) ||
    b.createdAt.localeCompare(a.createdAt) ||
    b.id.localeCompare(a.id)
  );
}

export function classifyDuplicateGroup(candidates: DuplicateCandidate[]): {
  shape: DuplicateShape;
  survivorId: string | null;
} {
  const done = candidates.filter(isCompletedCandidate);

  if (done.length === 0) {
    // Design rule: keep the oldest pending row. Groups can also consist of
    // only failed/cancelled rows; fall back to the oldest row overall so
    // classification stays total and deterministic.
    const pending = candidates.filter((c) => c.status === "pending").sort(byOldest);
    const survivor = pending[0] ?? [...candidates].sort(byOldest)[0];
    return { shape: "no_done", survivorId: survivor?.id ?? null };
  }

  if (done.length === 1) {
    return { shape: "one_done", survivorId: done[0].id };
  }

  const firstText = done[0].text.trim();
  const identical = done.every((c) => c.text.trim() === firstText);
  if (identical) {
    const survivor = [...done].sort(byNewestMetadata)[0];
    return { shape: "identical_done", survivorId: survivor.id };
  }

  // Conflicting completed texts must never be auto-resolved; a decisions
  // file entry has to name the survivor explicitly.
  return { shape: "conflict", survivorId: null };
}

export function groupCandidates(
  rows: DuplicateCandidate[],
): Map<string, DuplicateCandidate[]> {
  const groups = new Map<string, DuplicateCandidate[]>();
  for (const row of rows) {
    const key = `${row.paragraphId}|${row.lang}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  for (const list of groups.values()) list.sort(byOldest);
  return groups;
}

export function buildIntegrityReport(
  rows: DuplicateCandidate[],
  generatedAt: string,
): IntegrityReport {
  const byShape: Partial<Record<DuplicateShape, number>> = {};
  const byLang: Record<string, number> = {};
  const groups: DuplicateGroupReport[] = [];
  let extraRows = 0;

  const sortedKeys = [...groupCandidates(rows).entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [, candidates] of sortedKeys) {
    if (candidates.length < 2) continue;
    const { shape, survivorId } = classifyDuplicateGroup(candidates);
    const { paragraphId, lang } = candidates[0];
    byShape[shape] = (byShape[shape] ?? 0) + 1;
    byLang[lang] = (byLang[lang] ?? 0) + 1;
    extraRows += candidates.length - 1;
    groups.push({
      paragraphId,
      lang,
      shape,
      conflict: shape === "conflict",
      survivorId,
      candidates: candidates.map((c) => ({
        id: c.id,
        status: c.status,
        textLength: c.text.length,
        model: c.model,
        lastProvider: c.lastProvider,
        retryCount: c.retryCount,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        // Full novel text stays out of the report except where a human must
        // compare conflicting completed candidates.
        ...(shape === "conflict" ? { text: c.text } : {}),
      })),
    });
  }

  return {
    generatedAt,
    totals: {
      duplicateGroups: groups.length,
      extraRows,
      byShape,
      byLang,
    },
    groups,
  };
}

function sameMembership(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

/**
 * Build (or refresh) the conflict decisions file. Existing survivor choices
 * are preserved only while the group's candidate membership is unchanged;
 * stale decisions reset to null so the dedupe tool refuses to act on them.
 */
export function buildDecisionsSkeleton(
  report: IntegrityReport,
  existing?: ConflictDecisionsFile,
): ConflictDecisionsFile {
  const previous = new Map(
    (existing?.groups ?? []).map((g) => [`${g.paragraphId}|${g.lang}`, g]),
  );
  const groups: ConflictDecision[] = report.groups
    .filter((g) => g.conflict)
    .map((g) => {
      const candidateIds = g.candidates.map((c) => c.id);
      const prior = previous.get(`${g.paragraphId}|${g.lang}`);
      const keepPrior =
        prior &&
        prior.survivorId !== null &&
        candidateIds.includes(prior.survivorId) &&
        sameMembership(prior.candidateIds, candidateIds);
      return {
        paragraphId: g.paragraphId,
        lang: g.lang,
        candidateIds,
        survivorId: keepPrior ? prior.survivorId : null,
      };
    });
  return { groups };
}

const DUPLICATE_CANDIDATES_SQL = `
SELECT t.id, t.paragraph_id, t.lang, t.status, t.text, t.model,
       t.last_provider, t.error_message, t.tokens_used, t.retry_count,
       t.created_at, t.updated_at, p.source_text
FROM translations t
JOIN paragraphs p ON p.id = t.paragraph_id
JOIN (
  SELECT paragraph_id, lang
  FROM translations
  GROUP BY paragraph_id, lang
  HAVING COUNT(*) > 1
) d ON d.paragraph_id = t.paragraph_id AND d.lang = t.lang
ORDER BY t.paragraph_id, t.lang, t.created_at, t.id`;

export async function fetchDuplicateCandidates(
  client: Client,
): Promise<DuplicateCandidate[]> {
  const res = await client.execute(DUPLICATE_CANDIDATES_SQL);
  return res.rows.map((row) => ({
    id: String(row.id),
    paragraphId: String(row.paragraph_id),
    lang: String(row.lang),
    status: String(row.status),
    text: String(row.text ?? ""),
    model: row.model === null ? null : String(row.model),
    lastProvider: row.last_provider === null ? null : String(row.last_provider),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    tokensUsed: row.tokens_used === null ? null : Number(row.tokens_used),
    retryCount: Number(row.retry_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    sourceText: String(row.source_text ?? ""),
  }));
}

/** Read-only audit entrypoint: one SELECT, pure classification. */
export async function auditTranslationIntegrity(
  client: Client,
  now: Date = new Date(),
): Promise<IntegrityReport> {
  const rows = await fetchDuplicateCandidates(client);
  return buildIntegrityReport(rows, now.toISOString());
}

// ---------------------------------------------------------------------------
// Controlled duplicate cleanup (Task 3). Never runs without an explicit
// --apply from the operator; production apply additionally requires user
// approval per AI_TRANSLATION_GUIDE.md.
// ---------------------------------------------------------------------------

export class DedupeRefusalError extends Error {}

export interface DedupeAction {
  paragraphId: string;
  lang: string;
  shape: DuplicateShape;
  survivorId: string;
  archive: DuplicateCandidate[];
}

export interface UndecidedConflict {
  paragraphId: string;
  lang: string;
  reason: string;
}

export interface DedupePlan {
  actions: DedupeAction[];
  undecided: UndecidedConflict[];
}

/**
 * Turn current duplicate candidates plus the conflict decisions file into
 * concrete survivor/archive actions. Strict by default: any conflict group
 * without a valid decision throws. `tolerateUndecided` is for dry-run
 * summaries only and collects refusals instead.
 */
export function planDedupe(
  rows: DuplicateCandidate[],
  decisions: ConflictDecisionsFile,
  opts: { tolerateUndecided?: boolean } = {},
): DedupePlan {
  const decisionByKey = new Map(
    decisions.groups.map((g) => [`${g.paragraphId}|${g.lang}`, g]),
  );
  const actions: DedupeAction[] = [];
  const undecided: UndecidedConflict[] = [];

  const refuse = (paragraphId: string, lang: string, reason: string) => {
    if (!opts.tolerateUndecided) throw new DedupeRefusalError(reason);
    undecided.push({ paragraphId, lang, reason });
  };

  const sorted = [...groupCandidates(rows).entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [key, candidates] of sorted) {
    if (candidates.length < 2) continue;
    const { shape, survivorId } = classifyDuplicateGroup(candidates);
    const { paragraphId, lang } = candidates[0];
    let survivor = survivorId;

    if (shape === "conflict") {
      const decision = decisionByKey.get(key);
      const ids = candidates.map((c) => c.id);
      if (!decision || decision.survivorId === null) {
        refuse(
          paragraphId,
          lang,
          `conflict group ${paragraphId}/${lang} has no decisions-file survivor`,
        );
        continue;
      }
      if (
        !sameMembership(decision.candidateIds, ids) ||
        !ids.includes(decision.survivorId)
      ) {
        refuse(
          paragraphId,
          lang,
          `decisions membership for ${paragraphId}/${lang} does not match current candidates`,
        );
        continue;
      }
      survivor = decision.survivorId;
    }

    if (!survivor) {
      refuse(paragraphId, lang, `no survivor could be selected for ${paragraphId}/${lang}`);
      continue;
    }
    const survivorFinal = survivor;
    actions.push({
      paragraphId,
      lang,
      shape,
      survivorId: survivorFinal,
      archive: candidates.filter((c) => c.id !== survivorFinal),
    });
  }

  return { actions, undecided };
}

export interface DedupeApplyResult {
  groups: number;
  archived: number;
  deleted: number;
  remainingDuplicates: number;
}

async function assertNoActiveWork(client: Client, nowIso: string): Promise<void> {
  const active = await client.execute({
    sql: `SELECT
            SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
            SUM(CASE WHEN lease_expires_at IS NOT NULL AND lease_expires_at > ? THEN 1 ELSE 0 END) AS leased
          FROM translations`,
    args: [nowIso],
  });
  const processing = Number(active.rows[0]?.processing ?? 0);
  const leased = Number(active.rows[0]?.leased ?? 0);
  if (processing > 0) {
    throw new DedupeRefusalError(
      `refusing to apply: ${processing} translation(s) are still processing`,
    );
  }
  if (leased > 0) {
    throw new DedupeRefusalError(
      `refusing to apply: ${leased} unexpired lease(s) exist`,
    );
  }
}

export async function countDuplicateGroups(client: Client): Promise<number> {
  const res = await client.execute(
    `SELECT COUNT(*) AS c FROM (
       SELECT 1 FROM translations GROUP BY paragraph_id, lang HAVING COUNT(*) > 1
     )`,
  );
  return Number(res.rows[0]?.c ?? 0);
}

/**
 * Apply the dedupe plan against fresh data. Each loser is archived into
 * translation_attempts and deleted in the same transactional batch; both
 * statements are guarded by `updated_at` so a row that changed since the
 * in-memory plan was built is left untouched (a later re-audit reports it).
 */
export async function applyDedupe(
  client: Client,
  decisions: ConflictDecisionsFile,
  opts: { batchGroups?: number; now?: Date } = {},
): Promise<DedupeApplyResult> {
  const nowIso = (opts.now ?? new Date()).toISOString();
  await assertNoActiveWork(client, nowIso);

  const rows = await fetchDuplicateCandidates(client);
  const plan = planDedupe(rows, decisions);

  const batchGroups = opts.batchGroups ?? 50;
  let archived = 0;
  let deleted = 0;
  for (let i = 0; i < plan.actions.length; i += batchGroups) {
    const chunk = plan.actions.slice(i, i + batchGroups);
    const statements: InStatement[] = [];
    for (const action of chunk) {
      for (const loser of action.archive) {
        // quality_codes preserves the loser's original status/timestamps;
        // the attempts table has no dedicated columns for legacy metadata.
        const legacyCodes = JSON.stringify([
          `legacy_status:${loser.status}`,
          `legacy_created_at:${loser.createdAt}`,
          `legacy_updated_at:${loser.updatedAt}`,
        ]);
        statements.push({
          sql: `INSERT INTO translation_attempts
                  (id, translation_id, run_id, legacy_translation_id, provider,
                   model, reasoning_effort, prompt_version, source_hash, text,
                   status, quality_codes, error_message, tokens_used, is_active,
                   created_at)
                SELECT ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, 'imported', ?, ?, ?, 0, ?
                FROM translations WHERE id = ? AND updated_at = ?`,
          args: [
            randomUUID(),
            action.survivorId,
            loser.id,
            loser.lastProvider,
            loser.model,
            "legacy-dedupe",
            sourceHash(loser.sourceText ?? ""),
            loser.text,
            legacyCodes,
            loser.errorMessage,
            loser.tokensUsed,
            nowIso,
            loser.id,
            loser.updatedAt,
          ],
        });
        statements.push({
          sql: "DELETE FROM translations WHERE id = ? AND updated_at = ?",
          args: [loser.id, loser.updatedAt],
        });
      }
    }
    if (statements.length === 0) continue;
    const results = await client.batch(statements, "write");
    for (let s = 0; s < results.length; s += 2) {
      archived += Number(results[s]?.rowsAffected ?? 0);
      deleted += Number(results[s + 1]?.rowsAffected ?? 0);
    }
  }

  return {
    groups: plan.actions.length,
    archived,
    deleted,
    remainingDuplicates: await countDuplicateGroups(client),
  };
}
