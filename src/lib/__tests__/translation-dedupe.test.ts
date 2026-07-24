import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as schema from "@/lib/db/schema";
import { sourceHash } from "@/lib/translate/source-hash";
import {
  applyDedupe,
  DedupeRefusalError,
  planDedupe,
  type ConflictDecisionsFile,
  type DuplicateCandidate,
} from "@/lib/translation-integrity";
import { parseDedupeArgs } from "../../../scripts/dedupe-translations";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const NO_DECISIONS: ConflictDecisionsFile = { groups: [] };

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

describe("planDedupe", () => {
  it("picks survivors for auto-resolvable shapes", () => {
    const rows = [
      candidate({ id: "a1", paragraphId: "p1", createdAt: "2026-01-01T00:00:00.000Z" }),
      candidate({ id: "a2", paragraphId: "p1", createdAt: "2026-01-02T00:00:00.000Z" }),
      candidate({ id: "b1", paragraphId: "p2", status: "done", text: "译" }),
      candidate({ id: "b2", paragraphId: "p2" }),
      candidate({
        id: "c1",
        paragraphId: "p3",
        status: "done",
        text: "同",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      candidate({
        id: "c2",
        paragraphId: "p3",
        status: "done",
        text: "同",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    ];
    const plan = planDedupe(rows, NO_DECISIONS);
    const byPara = new Map(plan.actions.map((a) => [a.paragraphId, a]));
    expect(byPara.get("p1")?.survivorId).toBe("a1");
    expect(byPara.get("p1")?.archive.map((c) => c.id)).toEqual(["a2"]);
    expect(byPara.get("p2")?.survivorId).toBe("b1");
    expect(byPara.get("p2")?.archive.map((c) => c.id)).toEqual(["b2"]);
    expect(byPara.get("p3")?.survivorId).toBe("c2");
    expect(byPara.get("p3")?.archive.map((c) => c.id)).toEqual(["c1"]);
  });

  it("refuses a conflict group without a decisions entry", () => {
    const rows = [
      candidate({ id: "a", status: "done", text: "one" }),
      candidate({ id: "b", status: "done", text: "two" }),
    ];
    expect(() => planDedupe(rows, NO_DECISIONS)).toThrow(DedupeRefusalError);
  });

  it("refuses a decision whose membership no longer matches", () => {
    const rows = [
      candidate({ id: "a", status: "done", text: "one" }),
      candidate({ id: "b", status: "done", text: "two" }),
    ];
    const decisions: ConflictDecisionsFile = {
      groups: [
        { paragraphId: "p1", lang: "zh", candidateIds: ["a", "gone"], survivorId: "a" },
      ],
    };
    expect(() => planDedupe(rows, decisions)).toThrow(/membership/i);
  });

  it("honors a valid conflict decision", () => {
    const rows = [
      candidate({ id: "a", status: "done", text: "one" }),
      candidate({ id: "b", status: "done", text: "two" }),
    ];
    const decisions: ConflictDecisionsFile = {
      groups: [
        { paragraphId: "p1", lang: "zh", candidateIds: ["b", "a"], survivorId: "b" },
      ],
    };
    const plan = planDedupe(rows, decisions);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].survivorId).toBe("b");
    expect(plan.actions[0].archive.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("parseDedupeArgs", () => {
  it("defaults to dry run with the standard decisions path", () => {
    const parsed = parseDedupeArgs([]);
    expect(parsed.apply).toBe(false);
    expect(parsed.decisionsPath).toMatch(/translation-conflict-decisions\.json$/);
  });

  it("requires an explicit --apply and honors --decisions", () => {
    const parsed = parseDedupeArgs(["--apply", "--decisions", "x.json"]);
    expect(parsed.apply).toBe(true);
    expect(parsed.decisionsPath).toBe("x.json");
  });
});

describe("applyDedupe", () => {
  let client: Client;
  let db: TestDb;

  beforeAll(async () => {
    client = createClient({ url: "file::memory:" });
    await migrate(drizzle(client, { schema }), { migrationsFolder: "./drizzle" });
    // Dedupe operates on legacy pre-0014 duplicates; the fixtures seed
    // duplicate keys, so drop the 0014 unique index in this fixture database.
    await client.execute("DROP INDEX IF EXISTS idx_translations_paragraph_lang");
    db = drizzle(client, { schema });
  });

  afterAll(() => {
    client.close();
  });

  beforeEach(async () => {
    await db.delete(schema.translationAttempts).run();
    await db.delete(schema.translationRuns).run();
    await db.delete(schema.translations).run();
    await db.delete(schema.paragraphs).run();
    await db.delete(schema.chapters).run();
    await db.delete(schema.books).run();
  });

  async function seedParagraph(sourceText = "原文テキスト"): Promise<string> {
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
      sourceText,
      sourceMarkup: `<p>${sourceText}</p>`,
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

  it("refuses while any translation is processing", async () => {
    const para = await seedParagraph();
    await insertTranslation(para, { status: "processing" });
    await expect(applyDedupe(client, NO_DECISIONS)).rejects.toThrow(
      DedupeRefusalError,
    );
  });

  it("refuses while an unexpired lease exists", async () => {
    const para = await seedParagraph();
    await insertTranslation(para, {
      status: "pending",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(applyDedupe(client, NO_DECISIONS)).rejects.toThrow(/lease/i);
  });

  it("archives losers into translation_attempts and deletes them", async () => {
    const sourceText = "アーカイブ対象の原文";
    const para = await seedParagraph(sourceText);
    const survivor = await insertTranslation(para, {
      status: "done",
      text: "幸存译文",
      model: "claude-code:sonnet",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const loser = await insertTranslation(para, {
      status: "failed",
      text: "",
      model: "qwen2.5:7b",
      lastProvider: "ollama",
      errorMessage: "timeout",
      tokensUsed: 12,
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    const result = await applyDedupe(client, NO_DECISIONS);
    expect(result).toMatchObject({
      groups: 1,
      archived: 1,
      deleted: 1,
      remainingDuplicates: 0,
    });

    const rows = await db.select().from(schema.translations).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(survivor);
    expect(rows[0].text).toBe("幸存译文");

    const attempts = await db.select().from(schema.translationAttempts).all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      translationId: survivor,
      legacyTranslationId: loser,
      model: "qwen2.5:7b",
      provider: "ollama",
      errorMessage: "timeout",
      tokensUsed: 12,
      status: "imported",
      isActive: 0,
      sourceHash: sourceHash(sourceText),
    });
  });

  it("resolves a decided conflict and is idempotent on rerun", async () => {
    const para = await seedParagraph();
    const keep = await insertTranslation(para, {
      status: "done",
      text: "保留",
    });
    const drop = await insertTranslation(para, {
      status: "done",
      text: "放弃",
    });
    const decisions: ConflictDecisionsFile = {
      groups: [
        {
          paragraphId: para,
          lang: "zh",
          candidateIds: [keep, drop],
          survivorId: keep,
        },
      ],
    };

    const first = await applyDedupe(client, decisions);
    expect(first).toMatchObject({
      groups: 1,
      archived: 1,
      deleted: 1,
      remainingDuplicates: 0,
    });

    const survivorRow = await db
      .select()
      .from(schema.translations)
      .where(eq(schema.translations.id, keep))
      .get();
    expect(survivorRow?.text).toBe("保留");

    const second = await applyDedupe(client, decisions);
    expect(second).toMatchObject({
      groups: 0,
      archived: 0,
      deleted: 0,
      remainingDuplicates: 0,
    });
    const attempts = await db.select().from(schema.translationAttempts).all();
    expect(attempts).toHaveLength(1);
  });
});
