export async function register() {
  // Only run in Node.js runtime (not Edge) — libsql adapter is Node-only.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Task 3 rewrites migrate.ts to use libsql and re-enables this block.
    // The old better-sqlite3 migrator has been removed from package.json
    // (Task 1) but migrate.ts still imports it, so importing here would
    // break `next build`. Leaving migrations to `npm run db:migrate` in the
    // interim — Task 3 restores automatic migration on startup.

    // Re-queue any translations that were mid-flight when the previous
    // process died. The in-memory queue is empty after restart, but the
    // translation rows still read "pending"/"processing" — without this,
    // the reader would poll forever with nobody translating. Safe to
    // run every cold start; idempotent by translation id.
    try {
      const { resumePendingTranslations } = await import(
        "./lib/translate/resume"
      );
      const { requeued } = await resumePendingTranslations();
      if (requeued > 0) {
        console.log(
          `[instrumentation] Resumed ${requeued} pending translations`,
        );
      }
    } catch (err) {
      // Non-fatal: the user can still manually retry via the reader UI.
      console.error("[instrumentation] Resume pending failed:", err);
    }
  }
}
