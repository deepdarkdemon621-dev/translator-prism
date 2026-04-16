import { config } from "dotenv";
import { createClient } from "@libsql/client";
config({ path: ".env.worker" });
const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
// Use a literal ISO-8601 Z timestamp so string comparison matches the
// storage format ("2026-04-16T03:51:46.678Z"). datetime('now', '-N seconds')
// returns "YYYY-MM-DD HH:MM:SS" with a space — string-compares BIGGER than
// the stored T-format, so filters appeared to match nothing.
const cutoff = new Date(Date.now() - 120_000).toISOString();

const r = await client.execute({
  sql: "SELECT model, COUNT(*) c FROM translations WHERE status='done' AND updated_at > ? GROUP BY model",
  args: [cutoff],
});
console.log(`since ${cutoff}:`, r.rows);

const latest = await client.execute(
  "SELECT model, status, updated_at, error_message FROM translations ORDER BY updated_at DESC LIMIT 8",
);
console.log("\nlatest 8 rows (any status):");
for (const row of latest.rows) {
  console.log(` ${row.updated_at}  ${row.status.padEnd(10)}  ${row.model ?? "-"}  ${row.error_message ?? ""}`);
}

client.close();
