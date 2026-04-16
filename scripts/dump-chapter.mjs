import { createClient } from "@libsql/client";
const c = createClient({ url: "file:./data/db.sqlite" });
const chId = process.argv[2];
const r = await c.execute({ sql: "SELECT source_html FROM chapters WHERE id = ?", args: [chId] });
console.log(r.rows[0]?.source_html);
c.close();
