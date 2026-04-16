import { createClient } from "@libsql/client";
import * as cheerio from "cheerio";

const c = createClient({ url: "file:./data/db.sqlite" });
const chId = process.argv[2];
const r = await c.execute({ sql: "SELECT source_html FROM chapters WHERE id = ?", args: [chId] });
const html = r.rows[0]?.source_html;
c.close();

const $ = cheerio.load(html, { xmlMode: true });
console.log("body count:", $("body").length);
const body = $("body").get(0);
console.log("body tagName:", body?.tagName);
console.log("body children count:", $(body).children().length);
console.log("all <p> count:", $("p").length);

let emitted = 0;
const walk = (node, insideParagraph) => {
  if (node.type !== "tag") return;
  const tag = node.tagName?.toLowerCase();
  if (tag === "p") {
    const text = $(node).text().trim();
    if (text.length > 0) {
      emitted++;
      if (emitted <= 3) console.log(`  #${emitted}:`, text.substring(0, 60));
    }
    return;
  }
  if (tag === "img" && !insideParagraph) {
    emitted++;
    console.log("  img");
    return;
  }
  for (const kid of $(node).contents().toArray()) {
    walk(kid, insideParagraph || tag === "p");
  }
};
if (body) {
  for (const kid of $(body).contents().toArray()) {
    walk(kid, false);
  }
}
console.log("total emitted:", emitted);
