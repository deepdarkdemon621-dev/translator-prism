import { createClient, type Client, type InStatement } from "@libsql/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { randomUUID } from "crypto";
import * as schema from "@/lib/db/schema";
import {
  auditTranslationIntegrity,
  buildDecisionsSkeleton,
  buildIntegrityReport,
  classifyDuplicateGroup,
  type DuplicateCandidate,
} from "@/lib/translation-integrity";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

function candidate(overrides: Partial<DuplicateCandidate>): DuplicateCandidate {
  return {
    id: randomUUID(),
    paragraphId: "p1",
    lang: "zh",
    status: "pending",
    text: "",
    model: null,
    lastProvider: null,
    errorMessage: null,
    tokensUsed: null,
    retryCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sourceText: "原文",
    ...overrides,
  };
}

describe("classifyDuplicateGroup", () => {
  it("keeps the oldest pending row when no candidate is completed", () => {
    const older = candidate({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = candidate({ id: "b", createdAt: "2026-01-02T00:00:00.000Z" });
    const failed = candidate({
      id: "c",
      status: "failed",
      createdAt: "2025-12-30T00:00:00.000Z",
    });
    const result = classifyDuplicateGroup([newer, failed, older]);
    expect(result.shape).toBe("no_done");
    expect(result.survivorId).toBe("a");
  });

  it("falls back to the oldest row when no candidate is pending or done", () => {
    const cancelled = candidate({
      id: "a",
      status: "cancelled",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const failed = candidate({
      id: "b",
      status: "failed",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const result = classifyDuplicateGroup([cancelled, failed]);
    expect(result.shape).toBe("no_done");
    expect(result.survivorId).toBe("b");
  });

  it("keeps the single non-empty completed row", () => {
    const done = candidate({ id: "a", status: "done", text: "译文" });
    const emptyDone = candidate({ id: "b", status: "done", text: "  " });
    const pending = candidate({ id: "c" });
    const result = classifyDuplicateGroup([pending, emptyDone, done]);
    expect(result.shape).toBe("one_done");
    expect(result.survivorId).toBe("a");
  });

  it("keeps the newest metadata row when completed texts are identical", () => {
    const olderDone = candidate({
      id: "a",
      status: "done",
      text: "译文",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const newerDone = candidate({
      id: "b",
      status: "done",
      text: "译文 ",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    const result = classifyDuplicateGroup([olderDone, newerDone]);
    expect(result.shape).toBe("identical_done");
    expect(result.survivorId).toBe("b");
  });

  it("flags conflicting completed texts and refuses to pick a survivor", () => {
    const first = candidate({ id: "a", status: "done", text: "译文一" });
    const second = candidate({ id: "b", status: "done", text: "译文二" });
    const result = classifyDuplicateGroup([first, second]);
    expect(result.shape).toBe("conflict");
    expect(result.survivorId).toBeNull();
  });
});

describe("buildIntegrityReport", () => {
  it("summarizes totals and includes full text only for conflict groups", () => {
    const rows: DuplicateCandidate[] = [
      candidate({ id: "a1", paragraphId: "p1", lang: "zh" }),
      candidate({ id: "a2", paragraphId: "p1", lang: "zh" }),
      candidate({ id: "b1", paragraphId: "p2", lang: "en", status: "done", text: "one" }),
      candidate({ id: "b2", paragraphId: "p2", lang: "en", status: "done", text: "two" }),
      candidate({ id: "b3", paragraphId: "p2", lang: "en" }),
    ];
    const report = buildIntegrityReport(rows, "2026-07-24T00:00:00.000Z");

    expect(report.generatedAt).toBe("2026-07-24T00:00:00.000Z");
    expect(report.totals.duplicateGroups).toBe(2);
    expect(report.totals.extraRows).toBe(3);
    expect(report.totals.byShape).toEqual({ no_done: 1, conflict: 1 });
    expect(report.totals.byLang).toEqual({ zh: 1, en: 1 });

    const noDone = report.groups.find((g) => g.paragraphId === "p1");
    expect(noDone?.conflict).toBe(false);
    expect(noDone?.candidates.every((c) => c.text === undefined)).toBe(true);

    const conflict = report.groups.find((g) => g.paragraphId === "p2");
    expect(conflict?.conflict).toBe(true);
    expect(conflict?.survivorId).toBeNull();
    const doneTexts = conflict?.candidates
      .filter((c) => c.status === "done")
      .map((c) => c.text);
    expect(doneTexts).toEqual(["one", "two"]);
  });
});

describe("buildDecisionsSkeleton", () => {
  const report = buildIntegrityReport(
    [
      candidate({ id: "a1", paragraphId: "p1", lang: "zh" }),
      candidate({ id: "a2", paragraphId: "p1", lang: "zh" }),
      candidate({ id: "b1", paragraphId: "p2", lang: "en", status: "done", text: "one" }),
      candidate({ id: "b2", paragraphId: "p2", lang: "en", status: "done", text: "two" }),
    ],
    "2026-07-24T00:00:00.000Z",
  );

  it("creates entries only for conflict groups with null survivor", () => {
    const decisions = buildDecisionsSkeleton(report);
    expect(decisions.groups).toHaveLength(1);
    expect(decisions.groups[0]).toMatchObject({
      paragraphId: "p2",
      lang: "en",
      survivorId: null,
    });
    expect([...decisions.groups[0].candidateIds].sort()).toEqual(["b1", "b2"]);
  });

  it("preserves an existing decision when group membership is unchanged", () => {
    const existing = {
      groups: [
        { paragraphId: "p2", lang: "en", candidateIds: ["b2", "b1"], survivorId: "b1" },
      ],
    };
    const decisions = buildDecisionsSkeleton(report, existing);
    expect(decisions.groups[0].survivorId).toBe("b1");
  });

  it("resets a stale decision when group membership changed", () => {
    const existing = {
      groups: [
        { paragraphId: "p2", lang: "en", candidateIds: ["b1", "gone"], survivorId: "b1" },
      ],
    };
    const decisions = buildDecisionsSkeleton(report, existing);
    expect(decisions.groups[0].survivorId).toBeNull();
  });
});

describe("auditTranslationIntegrity", () => {
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
  });

  async function seedParagraph(): Promise<string> {
    const bookId = randomUUID();
    const chapterId = randomUUID();
    const paragraphId = randomUUID();
    await db.insert(schema.books).values({
      id: bookId,
      title: "T",
      author: "A",
      sourceLang: "ja",
      filePath: `/${bookId}.epub`,
      totalChapters: 1,
      status: "parsed",
    }).run();
    await db.insert(schema.chapters).values({
      id: chapterId,
      bookId,
      index: 0,
      title: "Ch",
      sourceHtml: "<p>x</p>",
      status: "pending",
    }).run();
    await db.insert(schema.paragraphs).values({
      id: paragraphId,
      chapterId,
      seq: 0,
      sourceText: "原文テキスト",
      sourceMarkup: "<p>原文テキスト</p>",
    }).run();
    return paragraphId;
  }

  async function insertTranslation(
    paragraphId: string,
    values: Partial<typeof schema.translations.$inferInsert>,
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.translations).values({
      id,
      paragraphId,
      lang: "zh",
      status: "pending",
      ...values,
    }).run();
    return id;
  }

  it("reports all duplicate shapes from a real database", async () => {
    const noDonePara = await seedParagraph();
    await insertTranslation(noDonePara, { lang: "zh" });
    await insertTranslation(noDonePara, { lang: "zh" });

    const conflictPara = await seedParagraph();
    await insertTranslation(conflictPara, { lang: "en", status: "done", text: "one" });
    await insertTranslation(conflictPara, { lang: "en", status: "done", text: "two" });

    const uniquePara = await seedParagraph();
    await insertTranslation(uniquePara, { lang: "zh", status: "done", text: "唯一" });

    const report = await auditTranslationIntegrity(client);
    expect(report.totals.duplicateGroups).toBe(2);
    expect(report.totals.extraRows).toBe(2);
    expect(report.totals.byShape).toEqual({ no_done: 1, conflict: 1 });
  });

  it("issues only read statements", async () => {
    const paragraphId = await seedParagraph();
    await insertTranslation(paragraphId, { lang: "zh" });
    await insertTranslation(paragraphId, { lang: "zh" });

    const executed: string[] = [];
    const spyClient = new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          return (stmt: InStatement) => {
            const sql = typeof stmt === "string" ? stmt : stmt.sql;
            executed.push(sql);
            return target.execute(stmt as never);
          };
        }
        if (prop === "batch" || prop === "transaction" || prop === "executeMultiple") {
          throw new Error(`audit must not call client.${String(prop)}`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const report = await auditTranslationIntegrity(spyClient);
    expect(report.totals.duplicateGroups).toBe(1);
    expect(executed.length).toBeGreaterThan(0);
    for (const sql of executed) {
      expect(sql.trim().toUpperCase().startsWith("SELECT")).toBe(true);
    }
  });
});
