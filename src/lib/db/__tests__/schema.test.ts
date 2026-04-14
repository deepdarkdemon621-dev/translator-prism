import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

describe("database schema", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeAll(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: "./drizzle" });
  });

  afterAll(() => {
    sqlite.close();
  });

  it("should insert and query a book", () => {
    const bookId = randomUUID();
    db.insert(schema.books).values({
      id: bookId,
      title: "転生したらスライムだった件",
      author: "伏瀬",
      sourceLang: "ja",
      filePath: "/uploads/test.epub",
      totalChapters: 10,
      status: "pending",
    }).run();

    const book = db.select().from(schema.books).where(eq(schema.books.id, bookId)).get();
    expect(book).toBeDefined();
    expect(book!.title).toBe("転生したらスライムだった件");
    expect(book!.sourceLang).toBe("ja");
  });

  it("should insert chapter with book FK", () => {
    const bookId = randomUUID();
    const chapterId = randomUUID();

    db.insert(schema.books).values({
      id: bookId, title: "Test", author: "A", sourceLang: "ja",
      filePath: "/test.epub", totalChapters: 1, status: "parsed",
    }).run();

    db.insert(schema.chapters).values({
      id: chapterId, bookId, index: 0, title: "Chapter 1",
      sourceHtml: "<p>Hello</p>", status: "pending",
    }).run();

    const chapter = db.select().from(schema.chapters).where(eq(schema.chapters.bookId, bookId)).get();
    expect(chapter).toBeDefined();
    expect(chapter!.title).toBe("Chapter 1");
  });

  it("should insert paragraph and translation", () => {
    const bookId = randomUUID();
    const chapterId = randomUUID();
    const paragraphId = randomUUID();
    const translationId = randomUUID();

    db.insert(schema.books).values({
      id: bookId, title: "Test", author: "A", sourceLang: "ja",
      filePath: "/t.epub", totalChapters: 1, status: "parsed",
    }).run();

    db.insert(schema.chapters).values({
      id: chapterId, bookId, index: 0, title: "Ch1",
      sourceHtml: "<p>テスト</p>", status: "done",
    }).run();

    db.insert(schema.paragraphs).values({
      id: paragraphId, chapterId, seq: 0,
      sourceText: "テスト", sourceMarkup: "<p>テスト</p>",
    }).run();

    db.insert(schema.translations).values({
      id: translationId, paragraphId, lang: "zh",
      text: "测试", status: "done", model: "claude-sonnet",
      tokensUsed: 50,
    }).run();

    const translation = db.select().from(schema.translations)
      .where(eq(schema.translations.paragraphId, paragraphId)).get();
    expect(translation).toBeDefined();
    expect(translation!.text).toBe("测试");
    expect(translation!.lang).toBe("zh");
  });

  it("should insert and query reading progress", () => {
    const bookId = randomUUID();
    const progressId = randomUUID();

    db.insert(schema.books).values({
      id: bookId, title: "Test", author: "A", sourceLang: "ja",
      filePath: "/t.epub", totalChapters: 5, status: "parsed",
    }).run();

    db.insert(schema.readingProgress).values({
      id: progressId, bookId, chapterIndex: 2, scrollPosition: 0.45,
    }).run();

    const progress = db.select().from(schema.readingProgress)
      .where(eq(schema.readingProgress.bookId, bookId)).get();
    expect(progress).toBeDefined();
    expect(progress!.chapterIndex).toBe(2);
    expect(progress!.scrollPosition).toBe(0.45);
  });

  it("should insert and query dictionary metadata", () => {
    const dictId = randomUUID();
    db.insert(schema.dictionaries).values({
      id: dictId,
      name: "JMdict (English)",
      format: "jmdict",
      sourceLang: "ja",
      entryCount: 200000,
    }).run();

    const dict = db.select().from(schema.dictionaries)
      .where(eq(schema.dictionaries.id, dictId)).get();
    expect(dict).toBeDefined();
    expect(dict!.format).toBe("jmdict");
    expect(dict!.entryCount).toBe(200000);
  });

  it("should insert into FTS5 dict_entries and find via MATCH", () => {
    const dictId = randomUUID();
    sqlite.prepare(
      "INSERT INTO dict_entries (dictionary_id, headword, reading, gloss) VALUES (?, ?, ?, ?)",
    ).run(dictId, "行く", "いく", "to go");
    sqlite.prepare(
      "INSERT INTO dict_entries (dictionary_id, headword, reading, gloss) VALUES (?, ?, ?, ?)",
    ).run(dictId, "食べる", "たべる", "to eat");

    const rows = sqlite.prepare(
      "SELECT headword, reading, gloss FROM dict_entries WHERE dict_entries MATCH ?",
    ).all("headword:行く") as Array<{ headword: string; reading: string; gloss: string }>;

    expect(rows.length).toBe(1);
    expect(rows[0].headword).toBe("行く");
    expect(rows[0].reading).toBe("いく");
  });

  it("should insert and query vocabulary entries", () => {
    const vocabId = randomUUID();
    db.insert(schema.vocabulary).values({
      id: vocabId,
      word: "頑張る",
      lang: "ja",
      reading: "がんばる",
      gloss: "to persist; to do one's best",
      note: "common verb",
    }).run();

    const entry = db.select().from(schema.vocabulary)
      .where(eq(schema.vocabulary.id, vocabId)).get();
    expect(entry).toBeDefined();
    expect(entry!.word).toBe("頑張る");
    expect(entry!.reading).toBe("がんばる");
    expect(entry!.sourceBookId).toBeNull();
  });
});
