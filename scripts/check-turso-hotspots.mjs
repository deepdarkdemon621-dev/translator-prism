import { config } from "dotenv";
import { createClient } from "@libsql/client";

config({ path: ".env.worker" });
config({ path: ".env.local" });
config();

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

async function show(label, sql) {
  const res = await client.execute(sql);
  console.log(`\n## ${label}`);
  console.log(JSON.stringify(res.rows, null, 2));
}

await show("row counts", `
SELECT 'books' table_name, COUNT(*) c FROM books
UNION ALL SELECT 'chapters', COUNT(*) FROM chapters
UNION ALL SELECT 'paragraphs', COUNT(*) FROM paragraphs
UNION ALL SELECT 'translations', COUNT(*) FROM translations
`);

await show("translation status", `
SELECT status, COUNT(*) c FROM translations GROUP BY status ORDER BY c DESC
`);

await show("worker claim plan", `EXPLAIN QUERY PLAN UPDATE translations
SET status = 'processing', updated_at = datetime('now')
WHERE id = (
  SELECT id FROM translations
  WHERE status = 'pending'
  ORDER BY created_at
  LIMIT 1
)
RETURNING id`);

await show("progress aggregate plan", `EXPLAIN QUERY PLAN SELECT c.book_id, COUNT(*)
FROM translations t
JOIN paragraphs p ON t.paragraph_id = p.id
JOIN chapters c ON p.chapter_id = c.id
GROUP BY c.book_id`);

client.close();
