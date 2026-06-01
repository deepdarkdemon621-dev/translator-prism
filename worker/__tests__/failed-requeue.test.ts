import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@/lib/db/schema";
import { requeueEligibleFailedTranslations } from "../failed-requeue";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let _testDb: TestDb | null = null;
let client: Client;

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!_testDb) throw new Error("test DB not initialised");
    return _testDb;
  },
}));

describe("requeueEligibleFailedTranslations", () => {
  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await client.execute(`
      CREATE TABLE translations (
        id text PRIMARY KEY,
        status text NOT NULL,
        retry_count integer NOT NULL DEFAULT 0,
        last_error_code text,
        error_message text,
        updated_at text NOT NULL
      )
    `);
    _testDb = drizzle(client, { schema });
  });

  it("requeues failed rows below the retry limit", async () => {
    await seed("t1", "failed", 0, "network");

    const count = await requeueEligibleFailedTranslations({
      retryLimit: 2,
      batchSize: 10,
    });

    expect(count).toBe(1);
    await expectRow("t1", {
      status: "pending",
      retry_count: 1,
      error_message: null,
    });
  });

  it("requeues historical failed rows with no last error code", async () => {
    await seed("t1", "failed", 0, null);

    const count = await requeueEligibleFailedTranslations({
      retryLimit: 2,
      batchSize: 10,
    });

    expect(count).toBe(1);
    await expectRow("t1", { status: "pending", retry_count: 1 });
  });

  it("does not requeue permanent or exhausted failures", async () => {
    await seed("auth", "failed", 0, "auth_error");
    await seed("model", "failed", 0, "model_not_found");
    await seed("quota", "failed", 0, "quota_exhausted");
    await seed("limit", "failed", 2, "network");

    const count = await requeueEligibleFailedTranslations({
      retryLimit: 2,
      batchSize: 10,
    });

    expect(count).toBe(0);
    await expectRow("auth", { status: "failed", retry_count: 0 });
    await expectRow("model", { status: "failed", retry_count: 0 });
    await expectRow("quota", { status: "failed", retry_count: 0 });
    await expectRow("limit", { status: "failed", retry_count: 2 });
  });
});

async function seed(
  id: string,
  status: string,
  retryCount: number,
  lastErrorCode: string | null,
) {
  await client.execute({
    sql: `
      INSERT INTO translations
        (id, status, retry_count, last_error_code, error_message, updated_at)
      VALUES (?, ?, ?, ?, 'old error', '2026-06-01T00:00:00.000Z')
    `,
    args: [id, status, retryCount, lastErrorCode],
  });
}

async function expectRow(
  id: string,
  expected: Partial<{
    status: string;
    retry_count: number;
    error_message: string | null;
  }>,
) {
  const res = await client.execute({
    sql: "SELECT status, retry_count, error_message FROM translations WHERE id = ?",
    args: [id],
  });
  expect(res.rows[0]).toMatchObject(expected);
}
