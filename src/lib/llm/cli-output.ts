export class CliOutputError extends Error {
  code = "invalid_output" as const;
}

export function parseClaudeCliOutput(stdout: string): string {
  return parseTranslationJson(stripMarkdownFence(stdout));
}

export function parseCodexCliOutput(stdout: string): string {
  let finalMessage: string | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      throw new CliOutputError("Codex CLI emitted invalid JSONL");
    }

    if (
      isRecord(event) &&
      event.type === "item.completed" &&
      isRecord(event.item) &&
      event.item.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      finalMessage = event.item.text;
    }
  }

  if (!finalMessage) {
    throw new CliOutputError("Codex CLI did not emit a final agent message");
  }

  return parseTranslationJson(stripMarkdownFence(finalMessage));
}

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function parseTranslationJson(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CliOutputError("CLI output was not valid JSON");
  }

  if (!isRecord(parsed) || typeof parsed.text !== "string" || !parsed.text.trim()) {
    throw new CliOutputError("Expected JSON object with a non-empty text string");
  }

  return parsed.text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
