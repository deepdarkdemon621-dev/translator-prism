import { extractClaudeTokenUsage, parseClaudeCliOutput, parseCodexCliOutput } from "./cli-output";
import { runCli } from "./cli-runner";
import { isClaudeCodeWithinAllowedWindow } from "./provider-window";
import type { LLMProvider, TranslationResult } from "./types";

const LANG_NAMES: Record<string, string> = {
  ja: "Japanese",
  zh: "Chinese",
  en: "English",
};

export class ClaudeCodeCliProvider implements LLMProvider {
  name = "claude-code";

  isAvailable(): boolean {
    return isClaudeCodeWithinAllowedWindow();
  }

  async translate(
    text: string,
    fromLang: string,
    toLang: string,
    model?: string,
  ): Promise<TranslationResult> {
    const useModel = model || process.env.CLAUDE_CODE_MODEL || "sonnet";
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      useModel,
      "--tools",
      "",
      "--no-session-persistence",
    ];

    if (process.env.CLAUDE_CODE_BARE === "true") {
      args.push("--bare");
    }
    if (process.env.CLAUDE_CODE_MAX_BUDGET_USD) {
      args.push("--max-budget-usd", process.env.CLAUDE_CODE_MAX_BUDGET_USD);
    }

    const result = await runCli({
      command: process.env.CLAUDE_CODE_COMMAND || "claude",
      args,
      stdin: buildTranslationPrompt(text, fromLang, toLang),
      timeoutMs: Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 120_000),
      env: buildClaudeCliEnv(),
    });

    return {
      text: parseClaudeCliOutput(result.stdout),
      tokensUsed: extractClaudeTokenUsage(result.stdout),
      model: `claude-code:${useModel}`,
    };
  }
}

function buildClaudeCliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.env.CLAUDE_CODE_BARE !== "true") {
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}

export class CodexCliProvider implements LLMProvider {
  name = "codex";

  constructor() {
    if (process.env.CODEX_CLI_ENABLED !== "true") {
      throw new Error("CODEX_CLI_ENABLED=true is required to use Codex CLI");
    }
  }

  async translate(
    text: string,
    fromLang: string,
    toLang: string,
    model?: string,
  ): Promise<TranslationResult> {
    const useModel = model || process.env.CODEX_CLI_MODEL || "";
    const args = ["exec"];
    if (useModel) args.push("-m", useModel);
    args.push("-s", "read-only", "--ephemeral", "--json");
    if (process.env.CODEX_CLI_ALLOW_BYPASS === "true") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    args.push("-");

    const result = await runCli({
      command: process.env.CODEX_CLI_COMMAND || "codex",
      args,
      stdin: buildTranslationPrompt(text, fromLang, toLang),
      timeoutMs: Number(process.env.CODEX_CLI_TIMEOUT_MS ?? 120_000),
    });

    return {
      text: parseCodexCliOutput(result.stdout),
      tokensUsed: 0,
      model: `codex:${useModel || "default"}`,
    };
  }
}

function buildTranslationPrompt(
  text: string,
  fromLang: string,
  toLang: string,
): string {
  const fromName = LANG_NAMES[fromLang] || fromLang;
  const toName = LANG_NAMES[toLang] || toLang;
  return [
    `Translate the following ${fromName} novel text into ${toName}.`,
    "Maintain literary style, tone, and nuance.",
    "Output ONLY the translated text. No explanations, no JSON, no formatting.",
    "",
    text,
  ].join("\n");
}
