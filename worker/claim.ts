// Lease-based, chapter/language-grouped claiming (ARCH-002). Replaces the
// startup full-table `processing -> pending` reset: a row is reclaimable only
// when its lease has expired, so a crashed worker's rows recover after
// WORKER_LEASE_MS without stealing live work. Operationally still single
// worker; leases are the safety net, not a multi-worker scheduler.
import { hostname } from "os";
import { randomUUID } from "crypto";
import type { Client } from "@libsql/client";
import { sourceHash } from "../src/lib/translate/source-hash";

export function makeWorkerId(): string {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}

export interface ClaimedTranslation {
  translationId: string;
  paragraphId: string;
  lang: string;
  seq: number;
  sourceText: string;
  sourceHash: string;
}

export interface ClaimedBatch {
  workerId: string;
  leaseExpiresAt: string;
  bookId: string;
  bookTitle: string;
  chapterId: string;
  chapterTitle: string;
  sourceLang: string;
  lang: string;
  items: ClaimedTranslation[];
}

export interface ClaimOptions {
  client: Client;
  workerId: string;
  batchSize: number;
  /** Optional per-batch source character budget (WORKER_BATCH_MAX_CHARS). */
  maxChars?: number;
  leaseMs: number;
  now?: Date;
}

// Eligible rows: pending, or processing whose lease expired. A NULL lease on
// a processing row is a legacy claim from the pre-lease worker; with no full
// reset anymore it must stay reclaimable or it would be stuck forever.
const ELIGIBLE =
  "(%A%.status = 'pending' OR (%A%.status = 'processing' AND (%A%.lease_expires_at IS NULL OR %A%.lease_expires_at < :now)))";

function eligible(alias: string): string {
  return ELIGIBLE.replaceAll("%A%", alias);
}

/**
 * Claim one chapter/language batch. Seed = oldest eligible row; the batch is
 * restricted to the seed's chapter and target language, ordered by paragraph
 * sequence, bounded by batchSize and (except for the first item) maxChars.
 * Duplicate (paragraph_id, lang) rows contribute one candidate per key.
 */
export async function claimTranslationBatch(
  opts: ClaimOptions,
): Promise<ClaimedBatch | null> {
  const now = (opts.now ?? new Date()).toISOString();
  const leaseExpiresAt = new Date(
    (opts.now ?? new Date()).getTime() + opts.leaseMs,
  ).toISOString();

  // Two index-seek probes replace the old single OR seed query: the OR across
  // status branches defeated idx_translations_status_created_id, so SQLite
  // full-scanned paragraphs plus a temp sort tree on every claim (~10^5 rows
  // read per call — this is what exhausted the Turso read quota). Each probe
  // is an ordered seek; the older of the two seeds wins, preserving the
  // "globally oldest eligible row" semantics.
  const seedSql = (where: string) => `
    SELECT p.chapter_id AS chapterId, t.lang AS lang,
           t.created_at AS createdAt, t.id AS seedId
    FROM translations t
    JOIN paragraphs p ON p.id = t.paragraph_id
    WHERE ${where}
    ORDER BY t.created_at, t.id
    LIMIT 1`;
  const [pendingSeed, reclaimSeed] = await Promise.all([
    opts.client.execute(seedSql("t.status = 'pending'")),
    opts.client.execute({
      sql: seedSql(
        "t.status = 'processing' AND (t.lease_expires_at IS NULL OR t.lease_expires_at < :now)",
      ),
      args: { now },
    }),
  ]);
  const seedRow = [pendingSeed.rows[0], reclaimSeed.rows[0]]
    .filter((row) => row !== undefined)
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return String(a.createdAt) < String(b.createdAt) ? -1 : 1;
      }
      return String(a.seedId) < String(b.seedId) ? -1 : 1;
    })[0];
  if (!seedRow) return null;

  const chapterId = String(seedRow.chapterId);
  const lang = String(seedRow.lang);

  // One query returns claim candidates plus everything needed to build the
  // model request — no follow-up per-row metadata query.
  const candidates = await opts.client.execute({
    sql: `SELECT * FROM (
            SELECT t.id AS translationId, t.paragraph_id AS paragraphId,
                   p.seq AS seq, p.source_text AS sourceText,
                   c.title AS chapterTitle, b.id AS bookId,
                   b.title AS bookTitle, b.source_lang AS sourceLang,
                   SUM(LENGTH(p.source_text)) OVER (ORDER BY p.seq, t.id) AS runningChars,
                   ROW_NUMBER() OVER (ORDER BY p.seq, t.id) AS rn
            FROM (
              SELECT t2.id, t2.paragraph_id,
                     ROW_NUMBER() OVER (
                       PARTITION BY t2.paragraph_id
                       ORDER BY t2.created_at, t2.id
                     ) AS dupRank
              FROM translations t2
              JOIN paragraphs p2 ON p2.id = t2.paragraph_id
              WHERE p2.chapter_id = :chapterId AND t2.lang = :lang
                AND ${eligible("t2")}
            ) t
            JOIN paragraphs p ON p.id = t.paragraph_id
            JOIN chapters c ON c.id = p.chapter_id
            JOIN books b ON b.id = c.book_id
            WHERE t.dupRank = 1
          )
          WHERE rn <= :batchSize AND (rn = 1 OR runningChars <= :maxChars)
          ORDER BY rn`,
    args: {
      now,
      chapterId,
      lang,
      batchSize: opts.batchSize,
      // No budget configured -> effectively unlimited.
      maxChars: opts.maxChars ?? Number.MAX_SAFE_INTEGER,
    },
  });
  if (candidates.rows.length === 0) return null;

  const ids = candidates.rows.map((row) => String(row.translationId));
  const placeholders = ids.map(() => "?").join(", ");
  // Re-check eligibility inside the UPDATE so a row that changed between the
  // candidate read and this write is silently dropped from the batch.
  const claimed = await opts.client.execute({
    sql: `UPDATE translations
          SET status = 'processing', claimed_by = ?, lease_expires_at = ?, updated_at = ?
          WHERE id IN (${placeholders})
            AND (status = 'pending' OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at < ?)))
          RETURNING id`,
    args: [opts.workerId, leaseExpiresAt, now, ...ids, now],
  });
  const claimedIds = new Set(claimed.rows.map((row) => String(row.id)));
  if (claimedIds.size === 0) return null;

  const first = candidates.rows[0];
  const items: ClaimedTranslation[] = candidates.rows
    .filter((row) => claimedIds.has(String(row.translationId)))
    .map((row) => {
      const sourceText = String(row.sourceText);
      return {
        translationId: String(row.translationId),
        paragraphId: String(row.paragraphId),
        lang,
        seq: Number(row.seq),
        sourceText,
        sourceHash: sourceHash(sourceText),
      };
    });

  return {
    workerId: opts.workerId,
    leaseExpiresAt,
    bookId: String(first.bookId),
    bookTitle: String(first.bookTitle),
    chapterId,
    chapterTitle: String(first.chapterTitle),
    sourceLang: String(first.sourceLang),
    lang,
    items,
  };
}

export interface RenewLeaseOptions {
  client: Client;
  workerId: string;
  translationIds: string[];
  leaseMs: number;
  now?: Date;
}

/** Extend leases for rows this worker still owns. Returns rows renewed. */
export async function renewLeases(opts: RenewLeaseOptions): Promise<number> {
  if (opts.translationIds.length === 0) return 0;
  const nowDate = opts.now ?? new Date();
  const leaseExpiresAt = new Date(nowDate.getTime() + opts.leaseMs).toISOString();
  const placeholders = opts.translationIds.map(() => "?").join(", ");
  const res = await opts.client.execute({
    sql: `UPDATE translations
          SET lease_expires_at = ?, updated_at = ?
          WHERE claimed_by = ? AND status = 'processing' AND id IN (${placeholders})`,
    args: [
      leaseExpiresAt,
      nowDate.toISOString(),
      opts.workerId,
      ...opts.translationIds,
    ],
  });
  return res.rowsAffected;
}

export interface ReleaseClaimOptions {
  client: Client;
  workerId: string;
  translationIds: string[];
  now?: Date;
}

/**
 * Return still-owned processing rows to the pending queue (used for batch
 * items the model returned no result for). Ownership-guarded like every
 * other lease write.
 */
export async function releaseClaims(opts: ReleaseClaimOptions): Promise<number> {
  if (opts.translationIds.length === 0) return 0;
  const placeholders = opts.translationIds.map(() => "?").join(", ");
  const res = await opts.client.execute({
    sql: `UPDATE translations
          SET status = 'pending', claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE claimed_by = ? AND status = 'processing' AND id IN (${placeholders})`,
    args: [
      (opts.now ?? new Date()).toISOString(),
      opts.workerId,
      ...opts.translationIds,
    ],
  });
  return res.rowsAffected;
}

export interface LeaseHeartbeatOptions {
  client: Client;
  workerId: string;
  leaseMs: number;
  intervalMs: number;
  /** Called each tick; return the translation IDs currently in flight. */
  getTranslationIds: () => string[];
  onError?: (err: unknown) => void;
}

/**
 * Renew all in-flight leases on an interval. Returns a stop function; after
 * stopping, unfinished leases simply expire (intentional — shutdown must not
 * hand rows to another owner early).
 */
export function startLeaseHeartbeat(opts: LeaseHeartbeatOptions): () => void {
  const timer = setInterval(() => {
    const translationIds = opts.getTranslationIds();
    if (translationIds.length === 0) return;
    renewLeases({
      client: opts.client,
      workerId: opts.workerId,
      translationIds,
      leaseMs: opts.leaseMs,
    }).catch((err) => opts.onError?.(err));
  }, opts.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
