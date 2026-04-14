export async function register() {
  // Only run in Node.js runtime (not Edge) — better-sqlite3 requires native Node
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runMigrations } = await import("./lib/db/migrate");
    try {
      runMigrations();
      console.log("[instrumentation] Database migrations applied");
    } catch (err) {
      console.error("[instrumentation] Migration failed:", err);
      throw err;
    }

    // Re-queue any translations that were mid-flight when the previous
    // process died. The in-memory queue is empty after restart, but the
    // translation rows still read "pending"/"processing" — without this,
    // the reader would poll forever with nobody translating. Safe to
    // run every cold start; idempotent by translation id.
    try {
      const { resumePendingTranslations } = await import(
        "./lib/translate/resume"
      );
      const { requeued } = resumePendingTranslations();
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
