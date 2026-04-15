import { config as loadEnv } from "dotenv";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import path from "path";
import { fileURLToPath } from "url";

// Load .env.local first (Next.js convention), then fall back to .env. dotenv
// doesn't overwrite existing vars, so real env always wins over both files.
loadEnv({ path: path.join(process.cwd(), ".env.local") });
loadEnv();

export async function runMigrations() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is required for migrations");

  const client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  client.close();
}

// Entrypoint guard: tsx runs this file as ESM, so `require.main === module`
// won't work. Compare argv[1] (script path) with this module's URL.
const isEntrypoint = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  runMigrations()
    .then(() => {
      console.log("Migrations complete.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
