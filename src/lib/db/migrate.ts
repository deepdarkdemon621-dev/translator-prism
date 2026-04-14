import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "db.sqlite");

export function runMigrations() {
  const sqlite = new Database(DB_PATH);
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  sqlite.close();
}

if (require.main === module) {
  runMigrations();
  console.log("Migrations complete.");
}
