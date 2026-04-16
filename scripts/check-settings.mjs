import { config } from "dotenv";
import { createClient } from "@libsql/client";
config({ path: ".env.worker" });
const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const row = await client.execute(
  "SELECT value, updated_at FROM app_settings WHERE key='global'",
);
if (row.rows.length === 0) {
  console.log("No app_settings row — using env fallback.");
} else {
  const v = JSON.parse(row.rows[0].value);
  // Redact key — never print it.
  const llm = v.llm || {};
  console.log("app_settings.llm:", {
    provider: llm.provider,
    model: llm.model,
    concurrency: llm.concurrency,
    apiKeyConfigured: !!llm.apiKey,
    apiKeyLength: (llm.apiKey || "").length,
  });
  console.log("updated_at:", row.rows[0].updated_at);
}

const recent = await client.execute(
  "SELECT model, COUNT(*) c FROM translations WHERE status='done' AND updated_at > datetime('now', '-5 minutes') GROUP BY model",
);
console.log("\nmodels used in last 5 min:", recent.rows);

client.close();
