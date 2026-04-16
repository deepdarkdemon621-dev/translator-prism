import { createClient } from "@libsql/client";
const c = createClient({ url: "file:./data/db.sqlite" });

const chId = process.argv[2] || "9f0fe441-faa4-4895-b760-09887b0f555f";

const chapter = await c.execute({
  sql: "SELECT id, title, status, length(source_html) as html_len FROM chapters WHERE id = ?",
  args: [chId],
});
console.log("chapter:", JSON.stringify(chapter.rows, null, 2));

const paras = await c.execute({
  sql: "SELECT id, seq, kind, length(source_text) as text_len, length(source_markup) as markup_len FROM paragraphs WHERE chapter_id = ? ORDER BY seq LIMIT 5",
  args: [chId],
});
console.log("paragraphs (first 5):", JSON.stringify(paras.rows, null, 2));

const count = await c.execute({
  sql: "SELECT kind, COUNT(*) as n FROM paragraphs WHERE chapter_id = ? GROUP BY kind",
  args: [chId],
});
console.log("paragraph counts by kind:", JSON.stringify(count.rows));

c.close();
