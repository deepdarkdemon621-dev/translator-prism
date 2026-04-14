import { getDb } from "@/lib/db";
import { books, chapters, paragraphs, translations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import archiver from "archiver";
import { getExportsStorage } from "@/lib/storage";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const LANG_LABELS: Record<string, string> = {
  ja: "日本語",
  zh: "中文",
  en: "English",
};

export async function exportJson(bookId: string): Promise<string> {
  const db = getDb();
  const book = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book) throw new Error("Book not found");

  const chapterList = db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(chapters.index)
    .all();

  const data = {
    book: { title: book.title, author: book.author, sourceLang: book.sourceLang },
    chapters: chapterList.map((ch) => {
      const paras = db
        .select()
        .from(paragraphs)
        .where(eq(paragraphs.chapterId, ch.id))
        .orderBy(paragraphs.seq)
        .all();

      return {
        index: ch.index,
        title: ch.title,
        paragraphs: paras.map((p) => {
          const trans = db
            .select()
            .from(translations)
            .where(eq(translations.paragraphId, p.id))
            .all();

          return {
            seq: p.seq,
            source: p.sourceText,
            translations: Object.fromEntries(trans.filter((t) => t.status === "done").map((t) => [t.lang, t.text])),
          };
        }),
      };
    }),
  };

  const fileName = `${bookId}.json`;
  await getExportsStorage().put(fileName, JSON.stringify(data, null, 2));
  return fileName;
}

export async function exportHtmlZip(bookId: string): Promise<string> {
  const db = getDb();
  const book = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book) throw new Error("Book not found");

  const fileName = `${bookId}.zip`;
  // openWriteStream is the streaming escape hatch — archiver needs a
  // real stream sink, not a buffer. Local backend returns an fs write
  // stream; cloud backends will wrap a multipart upload.
  const output = getExportsStorage().openWriteStream(fileName);
  const archive = archiver("zip", { zlib: { level: 9 } });

  const closed = new Promise<void>((resolve, reject) => {
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
    archive.on("warning", (w) => {
      if (w.code !== "ENOENT") reject(w);
    });
  });

  archive.pipe(output);

  const chapterList = db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(chapters.index)
    .all();

  const padWidth = Math.max(2, String(chapterList.length).length);

  const sourceLang = book.sourceLang;
  const allLangs = ["ja", "zh", "en"];

  type TransRow = typeof translations.$inferSelect;

  // CSS
  archive.append(
    `body{font-family:Georgia,'Noto Serif SC','Noto Serif JP',serif;max-width:1200px;margin:0 auto;padding:20px;background:#1a1a2e;color:#e0e0e0;}
.columns{display:flex;gap:20px;}.col{flex:1;}.col h3{text-align:center;color:#888;font-size:12px;text-transform:uppercase;}
p{line-height:1.8;margin:0 0 16px;padding:8px;border-radius:4px;}
a{color:#e94560;text-decoration:none;}a:hover{text-decoration:underline;}
h1{text-align:center;color:#e94560;}h2{color:#ccc;}`,
    { name: "style.css" },
  );

  // Index page
  let indexHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(book.title)}</title><link rel="stylesheet" href="style.css"></head><body>
<h1>${escapeHtml(book.title)}</h1><p style="text-align:center;color:#888">${escapeHtml(book.author)}</p><h2>目录</h2><ul>`;

  for (const ch of chapterList) {
    const chFileName = `chapter-${String(ch.index + 1).padStart(padWidth, "0")}.html`;
    indexHtml += `<li><a href="${chFileName}">${escapeHtml(ch.title)}</a></li>`;

    // Chapter page
    const paras = db.select().from(paragraphs).where(eq(paragraphs.chapterId, ch.id)).orderBy(paragraphs.seq).all();

    // Prefetch all translations per paragraph once per chapter
    const paraTranslations = new Map<string, TransRow[]>();
    for (const p of paras) {
      const trans = db.select().from(translations).where(eq(translations.paragraphId, p.id)).all();
      paraTranslations.set(p.id, trans);
    }

    let chHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(ch.title)}</title><link rel="stylesheet" href="style.css"></head><body>
<p><a href="index.html">← 目录</a></p><h1>${escapeHtml(ch.title)}</h1><div class="columns">`;

    for (const lang of allLangs) {
      chHtml += `<div class="col"><h3>${LANG_LABELS[lang] || lang}</h3>`;
      for (const p of paras) {
        if (lang === sourceLang) {
          chHtml += `<p>${escapeHtml(p.sourceText)}</p>`;
        } else {
          const trans = paraTranslations.get(p.id) || [];
          const t = trans.find((tr) => tr.lang === lang && tr.status === "done");
          chHtml += `<p>${t?.text ? escapeHtml(t.text) : "<em>未翻译</em>"}</p>`;
        }
      }
      chHtml += "</div>";
    }

    chHtml += "</div></body></html>";
    archive.append(chHtml, { name: chFileName });
  }

  indexHtml += "</ul></body></html>";
  archive.append(indexHtml, { name: "index.html" });

  archive.finalize();
  await closed;

  return fileName;
}
