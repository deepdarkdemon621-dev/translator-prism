// Controlled duplicate cleanup for translations. Dry-run by default; mutating
// the database requires an explicit --apply plus a completed conflict
// decisions file. Production apply additionally requires explicit user
// approval per AI_TRANSLATION_GUIDE.md — never run it on your own judgment.
//
//   npm run translations:dedupe -- --dry-run
//   npm run translations:dedupe -- --apply --decisions data/translation-conflict-decisions.json
import { config as loadEnv } from "dotenv";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { createClient } from "@libsql/client";

loadEnv({ path: path.join(process.cwd(), ".env.worker"), quiet: true });
loadEnv({ path: path.join(process.cwd(), ".env.local"), quiet: true });
loadEnv({ quiet: true });

import {
  applyDedupe,
  fetchDuplicateCandidates,
  planDedupe,
  type ConflictDecisionsFile,
} from "../src/lib/translation-integrity";

export interface DedupeArgs {
  apply: boolean;
  decisionsPath: string;
}

export function parseDedupeArgs(argv: string[]): DedupeArgs {
  let apply = false;
  let decisionsPath = path.join(
    process.cwd(),
    "data",
    "translation-conflict-decisions.json",
  );
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--dry-run") {
      apply = false;
    } else if (arg === "--decisions") {
      const next = argv[++i];
      if (!next) throw new Error("--decisions requires a file path");
      decisionsPath = next;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { apply, decisionsPath };
}

function describeTarget(url: string): string {
  if (url.startsWith("file:")) return url;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return "(unparseable url)";
  }
}

function loadDecisions(decisionsPath: string): ConflictDecisionsFile {
  try {
    return JSON.parse(readFileSync(decisionsPath, "utf8"));
  } catch {
    return { groups: [] };
  }
}

async function main() {
  const args = parseDedupeArgs(process.argv.slice(2));
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is required");

  const client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });
  const decisions = loadDecisions(args.decisionsPath);
  console.log(
    `[dedupe] target=${describeTarget(url)} mode=${args.apply ? "APPLY" : "dry-run"} decisions=${args.decisionsPath} (${decisions.groups.length} entries)`,
  );

  if (!args.apply) {
    const rows = await fetchDuplicateCandidates(client);
    const plan = planDedupe(rows, decisions, { tolerateUndecided: true });
    client.close();
    const byShape: Record<string, number> = {};
    let archived = 0;
    for (const action of plan.actions) {
      byShape[action.shape] = (byShape[action.shape] ?? 0) + 1;
      archived += action.archive.length;
    }
    console.log(
      `[dedupe] dry-run: resolvableGroups=${plan.actions.length} rowsToArchive=${archived} byShape=${JSON.stringify(byShape)}`,
    );
    console.log(`[dedupe] dry-run: undecidedConflicts=${plan.undecided.length}`);
    if (plan.undecided.length > 0) {
      console.log(
        "[dedupe] fill survivorId for every conflict group in the decisions file before --apply",
      );
    }
    console.log("[dedupe] no changes were made; pass --apply to execute");
    return;
  }

  const result = await applyDedupe(client, decisions);
  client.close();
  console.log(
    `[dedupe] applied: groups=${result.groups} archived=${result.archived} deleted=${result.deleted} remainingDuplicates=${result.remainingDuplicates}`,
  );
  if (result.remainingDuplicates > 0) {
    console.error(
      "[dedupe] FAILED: duplicates remain after apply; re-run the audit and review before retrying",
    );
    process.exit(1);
  }
}

const isEntrypoint = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main().catch((err) => {
    console.error("[dedupe] failed:", err);
    process.exit(1);
  });
}
