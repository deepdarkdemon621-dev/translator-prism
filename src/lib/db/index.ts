import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

let _client: Client | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (!_db) {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) throw new Error("TURSO_DATABASE_URL is required");
    _client = createClient({
      url,
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    });
    _db = drizzle(_client, { schema });
  }
  return _db;
}

/**
 * Raw libsql client. Use for FTS5 virtual tables and other features
 * Drizzle's DSL doesn't model. Returns a Client with `.execute({ sql, args })`.
 */
export function getLibsqlClient(): Client {
  getDb();
  return _client!;
}
