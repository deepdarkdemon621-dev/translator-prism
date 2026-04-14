import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "db.sqlite");

let _sqlite: Database.Database | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (!_db) {
    _sqlite = new Database(DB_PATH);
    _sqlite.pragma("journal_mode = WAL");
    _sqlite.pragma("foreign_keys = ON");
    _db = drizzle(_sqlite, { schema });
  }
  return _db;
}

/**
 * Raw better-sqlite3 handle. Use this for FTS5 virtual tables and other
 * features Drizzle's DSL doesn't model.
 */
export function getSqlite(): Database.Database {
  getDb();
  return _sqlite!;
}
