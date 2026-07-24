// Read-only duplicate audit for translations. Writes a deterministic report
// plus a conflict decisions skeleton under data/ (both gitignored). Performs
// no database writes; see scripts/dedupe-translations.ts for controlled
// cleanup.
//
//   npm run translations:audit
//
// Env resolution matches the worker: explicit env wins, then .env.worker,
// then .env.local, then .env.
import { config as loadEnv } from "dotenv";
import path from "path";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { createClient } from "@libsql/client";

loadEnv({ path: path.join(process.cwd(), ".env.worker"), quiet: true });
loadEnv({ path: path.join(process.cwd(), ".env.local"), quiet: true });
loadEnv({ quiet: true });

import {
  auditTranslationIntegrity,
  buildDecisionsSkeleton,
  type ConflictDecisionsFile,
} from "../src/lib/translation-integrity";

const REPORT_PATH = path.join(process.cwd(), "data", "translation-integrity-report.json");
const DECISIONS_PATH = path.join(
  process.cwd(),
  "data",
  "translation-conflict-decisions.json",
);

function describeTarget(url: string): string {
  // Never echo tokens or query strings; show just enough to confirm target.
  if (url.startsWith("file:")) return url;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return "(unparseable url)";
  }
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is required");

  const client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });

  console.log(`[audit] target=${describeTarget(url)} (read-only)`);
  const report = await auditTranslationIntegrity(client);
  client.close();

  let existing: ConflictDecisionsFile | undefined;
  try {
    existing = JSON.parse(readFileSync(DECISIONS_PATH, "utf8"));
  } catch {
    // No prior decisions file (or unreadable) — start fresh.
  }
  const decisions = buildDecisionsSkeleton(report, existing);

  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  writeFileSync(DECISIONS_PATH, JSON.stringify(decisions, null, 2));

  const { totals } = report;
  console.log(
    `[audit] duplicateGroups=${totals.duplicateGroups} extraRows=${totals.extraRows}`,
  );
  console.log(`[audit] byShape=${JSON.stringify(totals.byShape)}`);
  console.log(`[audit] byLang=${JSON.stringify(totals.byLang)}`);
  const undecided = decisions.groups.filter((g) => g.survivorId === null).length;
  console.log(
    `[audit] conflictGroups=${decisions.groups.length} undecided=${undecided}`,
  );
  console.log(`[audit] report=${REPORT_PATH}`);
  console.log(`[audit] decisions=${DECISIONS_PATH}`);
}

main().catch((err) => {
  console.error("[audit] failed:", err);
  process.exit(1);
});
