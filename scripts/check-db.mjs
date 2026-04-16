import { createClient } from "@libsql/client";
const c = createClient({ url: "file:./data/db.sqlite" });
const journal = await c.execute(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'",
);
console.log("journal table:", JSON.stringify(journal.rows));
if (journal.rows.length > 0) {
  const entries = await c.execute("SELECT * FROM __drizzle_migrations");
  console.log("migrations applied:", JSON.stringify(entries.rows, null, 2));
}
const cols = await c.execute("PRAGMA table_info(paragraphs)");
console.log(
  "paragraphs cols:",
  cols.rows.map((r) => r.name).join(","),
);
c.close();
