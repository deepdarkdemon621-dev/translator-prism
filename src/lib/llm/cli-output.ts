export class CliOutputError extends Error {
  code = "invalid_output" as const;
}

/**
 * Parse the JSON envelope produced by `claude -p --output-format json`.
 * The translation is in the top-level `result` field as plain text.
 */
export function parseClaudeCliOutput(stdout: string): string {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout.trim());
  } catch {
    throw new CliOutputError("Claude CLI output was not valid JSON");
  }
  if (
    isRecord(envelope) &&
    envelope.type === "result" &&
    typeof envelope.result === "string"
  ) {
    const text = envelope.result.trim();
    if (!text) throw new CliOutputError("Claude CLI returned empty translation");
    return text;
  }
  throw new CliOutputError(
    "Claude CLI output did not match expected --output-format json envelope",
  );
}

/**
 * Extract output token count from a `claude -p --output-format json` envelope.
 * Returns 0 if the field is absent or unparseable.
 */
export function extractClaudeTokenUsage(stdout: string): number {
  try {
    const envelope = JSON.parse(stdout.trim());
    if (isRecord(envelope) && isRecord(envelope.usage)) {
      return Number(envelope.usage.output_tokens) || 0;
    }
  } catch {
    // ignore
  }
  return 0;
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
      // Take the last agent_message — Codex may emit intermediate tool messages
      // before the final response.
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
