import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";

/**
 * Text content of a paragraph node with inline <img>/<image> alt text
 * substituted in document position. Old Japanese EPUBs render rare kanji as
 * small inline images (gaiji) whose glyph lives in alt; plain `.text()`
 * drops them and mangles names (櫛田 -> 田). Empty alts contribute nothing.
 *
 * Callers gate on the node already containing real text, so image-only
 * wrapper paragraphs keep flowing through the image-row path.
 */
export function textWithImageAlts($: CheerioAPI, node: Element): string {
  const clone = $(node).clone();
  clone.find("img, image").each((_, img) => {
    const alt = ($(img).attr("alt") || "").trim();
    $(img).replaceWith(alt);
  });
  return clone.text();
}
