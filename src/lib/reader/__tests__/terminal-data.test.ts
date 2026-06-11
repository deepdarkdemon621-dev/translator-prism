import { createClient, type Client } from "@libsql/client";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import {
  listTerminalBooks,
  loadTerminalBook,
  loadTerminalChapter,
  loadTerminalDbProgress,
  saveTerminalDbProgress,
} from "@/lib/reader/terminal-data";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

describe("terminal reader data helpers", () => {
  let client: Client;
  let db: TestDb;

  beforeAll(async () => {
    client = createClient({ url: "file::memory:" });
    await migrate(drizzle(client, { schema }), { migrationsFolder: "./drizzle" });
    db = drizzle(client, { schema });
  });

  afterAll(() => {
    client.close();
  });

  beforeEach(async () => {
    await db.delete(schema.translations).run();
    await db.delete(schema.paragraphs).run();
    await db.delete(schema.chapters).run();
    await db.delete(schema.books).run();
    await db.delete(schema.users).run();
  });

  async function makeUser(): Promise<string> {
    const id = randomUUID();
    await db
      .insert(schema.users)
      .values({ id, email: `${id}@example.test`, isAdmin: 1 })
      .run();
    return id;
  }

  async function makeBook(params: {
    id: string;
    userId: string;
    sourceLang?: string;
    title?: string;
  }) {
    await db
      .insert(schema.books)
      .values({
        id: params.id,
        title: params.title ?? "Terminal Book",
        author: "Reader Author",
        sourceLang: params.sourceLang ?? "ja",
        filePath: `/${params.id}.epub`,
        totalChapters: 2,
        status: "parsed",
        userId: params.userId,
      })
      .run();
  }

  async function makeChapter(params: {
    id: string;
    bookId: string;
    index: number;
    title: string;
    status?: string;
  }) {
    await db
      .insert(schema.chapters)
      .values({
        id: params.id,
        bookId: params.bookId,
        index: params.index,
        title: params.title,
        sourceHtml: `<p>${params.title}</p>`,
        status: params.status ?? "pending",
      })
      .run();
  }

  async function makeParagraph(params: {
    id: string;
    chapterId: string;
    seq: number;
    sourceText?: string;
    kind?: "text" | "image";
  }) {
    await db
      .insert(schema.paragraphs)
      .values({
        id: params.id,
        chapterId: params.chapterId,
        seq: params.seq,
        sourceText: params.sourceText ?? "",
        sourceMarkup: params.kind === "image" ? "<img src=\"cover.jpg\">" : "<p>x</p>",
        kind: params.kind ?? "text",
      })
      .run();
  }

  async function makeTranslation(params: {
    paragraphId: string;
    lang: string;
    text: string;
    status?: string;
    errorMessage?: string | null;
  }) {
    await db
      .insert(schema.translations)
      .values({
        id: randomUUID(),
        paragraphId: params.paragraphId,
        lang: params.lang,
        text: params.text,
        status: params.status ?? "done",
        errorMessage: params.errorMessage ?? null,
      })
      .run();
  }

  it("loads a book summary with chapters ordered by index", async () => {
    const userId = await makeUser();
    const bookId = randomUUID();
    const firstChapterId = randomUUID();
    const secondChapterId = randomUUID();
    await makeBook({ id: bookId, userId, sourceLang: "zh" });
    await makeChapter({
      id: secondChapterId,
      bookId,
      index: 1,
      title: "Second",
      status: "done",
    });
    await makeChapter({
      id: firstChapterId,
      bookId,
      index: 0,
      title: "First",
      status: "translating",
    });

    await expect(loadTerminalBook(db, bookId)).resolves.toEqual({
      id: bookId,
      title: "Terminal Book",
      author: "Reader Author",
      sourceLang: "zh",
      chapters: [
        { id: firstChapterId, index: 0, title: "First", status: "translating" },
        { id: secondChapterId, index: 1, title: "Second", status: "done" },
      ],
    });
    await expect(loadTerminalBook(db, "missing")).resolves.toBeNull();
  });

  it("lists recent terminal books with title and id", async () => {
    const userId = await makeUser();
    await makeBook({ id: "book-a", userId, title: "Older" });
    await makeBook({ id: "book-b", userId, title: "Newer", sourceLang: "zh" });

    await expect(listTerminalBooks(db, 10)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "book-a",
          title: "Older",
          author: "Reader Author",
          sourceLang: "ja",
          status: "parsed",
        }),
        expect.objectContaining({
          id: "book-b",
          title: "Newer",
          author: "Reader Author",
          sourceLang: "zh",
          status: "parsed",
        }),
      ]),
    );
  });

  it("loads a chapter with sorted paragraphs, image markers, translations, and languages", async () => {
    const userId = await makeUser();
    const bookId = randomUUID();
    const chapterId = randomUUID();
    const textParagraphId = randomUUID();
    const imageParagraphId = randomUUID();
    await makeBook({ id: bookId, userId });
    await makeChapter({ id: chapterId, bookId, index: 0, title: "Chapter", status: "done" });
    await makeParagraph({
      id: imageParagraphId,
      chapterId,
      seq: 2,
      kind: "image",
    });
    await makeParagraph({
      id: textParagraphId,
      chapterId,
      seq: 1,
      sourceText: "Source text",
    });
    await makeTranslation({
      paragraphId: textParagraphId,
      lang: "zh",
      text: "Chinese text",
    });
    await makeTranslation({
      paragraphId: textParagraphId,
      lang: "en",
      text: "",
      status: "failed",
      errorMessage: "quota exceeded",
    });

    await expect(loadTerminalChapter(db, chapterId, "ja")).resolves.toEqual({
      id: chapterId,
      title: "Chapter",
      status: "done",
      availableLangs: ["zh", "en"],
      paragraphs: [
        {
          seq: 1,
          kind: "text",
          sourceLang: "ja",
          sourceText: "Source text",
          translations: {
            en: { text: "", status: "failed", errorMessage: "quota exceeded" },
            zh: { text: "Chinese text", status: "done", errorMessage: null },
          },
        },
        {
          seq: 2,
          kind: "image",
          sourceLang: "ja",
          sourceText: "[image]",
          translations: {},
        },
      ],
    });
    await expect(loadTerminalChapter(db, "missing", "ja")).resolves.toBeNull();
  });

  it("keeps language buckets across translations for multiple paragraphs", async () => {
    const userId = await makeUser();
    const bookId = randomUUID();
    const chapterId = randomUUID();
    const firstParagraphId = randomUUID();
    const secondParagraphId = randomUUID();
    await makeBook({ id: bookId, userId, sourceLang: "en" });
    await makeChapter({ id: chapterId, bookId, index: 0, title: "Batch", status: "done" });
    await makeParagraph({
      id: secondParagraphId,
      chapterId,
      seq: 2,
      sourceText: "Second",
    });
    await makeParagraph({
      id: firstParagraphId,
      chapterId,
      seq: 1,
      sourceText: "First",
    });
    await makeTranslation({ paragraphId: firstParagraphId, lang: "zh", text: "First zh" });
    await makeTranslation({ paragraphId: firstParagraphId, lang: "ja", text: "First ja" });
    await makeTranslation({ paragraphId: secondParagraphId, lang: "zh", text: "Second zh" });
    await makeTranslation({ paragraphId: secondParagraphId, lang: "en", text: "Second edited" });

    const chapter = await loadTerminalChapter(db, chapterId, "en");

    expect(chapter?.availableLangs).toEqual(["ja", "zh", "en"]);
    expect(chapter?.paragraphs.map((paragraph) => paragraph.translations)).toEqual([
      {
        ja: { text: "First ja", status: "done", errorMessage: null },
        zh: { text: "First zh", status: "done", errorMessage: null },
      },
      {
        en: { text: "Second edited", status: "done", errorMessage: null },
        zh: { text: "Second zh", status: "done", errorMessage: null },
      },
    ]);
  });

  it("saves and reloads terminal progress through reading_progress", async () => {
    const userId = await makeUser();
    const bookId = randomUUID();
    await makeBook({ id: bookId, userId });

    await expect(loadTerminalDbProgress(db, bookId)).resolves.toBeNull();

    await saveTerminalDbProgress(db, bookId, {
      chapterIndex: 2,
      page: 4,
      langs: "ja,zh",
    });

    await expect(loadTerminalDbProgress(db, bookId)).resolves.toEqual({
      chapterIndex: 2,
      page: 4,
      langs: "auto",
    });

    await saveTerminalDbProgress(db, bookId, {
      chapterIndex: 3,
      page: 1,
      langs: "en",
    });

    const rows = await db
      .select()
      .from(schema.readingProgress)
      .where(eq(schema.readingProgress.bookId, bookId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bookId,
      userId,
      chapterIndex: 3,
      scrollPosition: 1,
    });
  });
});
