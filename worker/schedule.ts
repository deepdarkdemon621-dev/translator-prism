import { isClaudeCodeWithinAllowedWindow } from "../src/lib/llm/provider-window";

export function shouldClaimTranslationWork(now = new Date()): boolean {
  if (process.env.WORKER_CLAUDE_WINDOW_ONLY !== "true") return true;
  return isClaudeCodeWithinAllowedWindow(now);
}
