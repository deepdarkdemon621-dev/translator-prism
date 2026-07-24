import {
  CliOutputError,
  extractClaudeTokenUsage,
  parseClaudeBatchCliOutput,
  parseClaudeCliOutput,
  parseCodexBatchCliOutput,
  parseCodexCliOutput,
} from "./cli-output";
import { runCli } from "./cli-runner";
import { isClaudeCodeWithinAllowedWindow } from "./provider-window";
import type {
  ChapterBatchRequest,
  LLMProvider,
  TranslationBatchResult,
  TranslationResult,
} from "./types";

const LANG_NAMES: Record<string, string> = {
  ja: "Japanese",
  zh: "Chinese",
  en: "English",
};

// Bump when buildChapterBatchPrompt (or the single prompt) changes shape in a
// way that could alter output quality; stored on runs/attempts for audit.
export const CHAPTER_BATCH_PROMPT_VERSION = "chapter-batch-v1";

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

  async translateBatch(
    request: ChapterBatchRequest,
    model?: string,
  ): Promise<TranslationBatchResult[]> {
    if (request.items.length === 0) return [];

    const useModel = model || process.env.CLAUDE_CODE_MODEL || "sonnet";
    const args = buildClaudeArgs(useModel);

    const result = await runCli({
      command: process.env.CLAUDE_CODE_COMMAND || "claude",
      args,
      stdin: buildChapterBatchPrompt(request),
      timeoutMs: batchTimeoutMs("CLAUDE_CODE", request.items.length),
      env: buildClaudeCliEnv(),
    });

    const parsed = parseClaudeBatchCliOutput(result.stdout);
    if (parsed.length === 0) {
      throw new CliOutputError("Claude batch output contained no translations");
    }

    // Unknown/duplicate/missing IDs pass through: per-item acceptance is the
    // validation layer's job so bad items cannot fail valid siblings.
    const tokensPerRow = Math.ceil(
      extractClaudeTokenUsage(result.stdout) / parsed.length,
    );
    return parsed.map((item) => ({
      id: item.id,
      text: item.text,
      tokensUsed: tokensPerRow,
      model: `claude-code:${useModel}`,
    }));
  }
}

function buildClaudeCliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.env.CLAUDE_CODE_BARE !== "true") {
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}

function buildClaudeArgs(useModel: string): string[] {
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
  return args;
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
    const result = await runCli({
      command: process.env.CODEX_CLI_COMMAND || "codex",
      args: buildCodexArgs(useModel),
      stdin: buildTranslationPrompt(text, fromLang, toLang),
      timeoutMs: Number(process.env.CODEX_CLI_TIMEOUT_MS ?? 120_000),
    });

    return {
      text: parseCodexCliOutput(result.stdout),
      tokensUsed: 0,
      model: `codex:${useModel || "default"}`,
    };
  }

  async translateBatch(
    request: ChapterBatchRequest,
    model?: string,
  ): Promise<TranslationBatchResult[]> {
    if (request.items.length === 0) return [];

    const useModel = model || process.env.CODEX_CLI_MODEL || "";
    const result = await runCli({
      command: process.env.CODEX_CLI_COMMAND || "codex",
      args: buildCodexArgs(useModel),
      stdin: buildChapterBatchPrompt(request),
      timeoutMs: batchTimeoutMs("CODEX_CLI", request.items.length),
    });

    const parsed = parseCodexBatchCliOutput(result.stdout);
    if (parsed.length === 0) {
      throw new CliOutputError("Codex batch output contained no translations");
    }

    return parsed.map((item) => ({
      id: item.id,
      text: item.text,
      tokensUsed: 0,
      model: `codex:${useModel || "default"}`,
    }));
  }
}

function buildCodexArgs(useModel: string): string[] {
  const args = ["exec"];
  if (useModel) args.push("-m", useModel);
  const reasoningEffort = process.env.CODEX_CLI_REASONING_EFFORT?.trim();
  if (reasoningEffort) {
    args.push(
      "-c",
      `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
    );
  }
  args.push("-s", "read-only", "--ephemeral", "--json");
  if (process.env.CODEX_CLI_ALLOW_BYPASS === "true") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  args.push("-");
  return args;
}

/**
 * Batch CLI timeout: base timeout plus a per-item increment so a large
 * chapter batch is not killed by the single-paragraph default. Base env vars
 * keep their existing names/defaults.
 */
function batchTimeoutMs(prefix: "CLAUDE_CODE" | "CODEX_CLI", itemCount: number): number {
  const base = Number(process.env[`${prefix}_TIMEOUT_MS`] ?? 120_000);
  const perItem = Number(process.env[`${prefix}_BATCH_ITEM_TIMEOUT_MS`] ?? 10_000);
  return base + perItem * Math.max(0, itemCount - 1);
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

function buildChapterBatchPrompt(request: ChapterBatchRequest): string {
  const fromName = LANG_NAMES[request.sourceLang] || request.sourceLang;
  const toName = LANG_NAMES[request.targetLang] || request.targetLang;
  return [
    `You are translating the ${fromName} novel "${request.bookTitle}", chapter "${request.chapterTitle}", into ${toName}.`,
    "Translate every item completely. Maintain literary style, tone, honorifics, and character voice.",
    "Keep names, places, and recurring terminology consistent across items.",
    "Use the book/chapter context only for consistency; never include it in the output.",
    "Return ONLY valid JSON in this exact shape:",
    '{"translations":[{"id":"same id","text":"translated text"}]}',
    "Rules: exactly one object per input id, preserve ids exactly, keep input order, no extra items, no explanations, no Markdown.",
    "",
    JSON.stringify({
      bookTitle: request.bookTitle,
      chapterTitle: request.chapterTitle,
      sourceLang: fromName,
      targetLang: toName,
      items: request.items.map((item) => ({
        id: item.id,
        seq: item.seq,
        text: item.text,
      })),
    }),
  ].join("\n");
}
