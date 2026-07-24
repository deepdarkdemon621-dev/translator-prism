import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CliOutputError,
  extractClaudeTokenUsage,
  parseClaudeBatchCliOutput,
  parseClaudeCliOutput,
  parseCodexBatchCliOutput,
  parseCodexCliOutput,
} from "../cli-output";

const fixturesDir = join(__dirname, "..", "__fixtures__");

const claudeEnvelope = (result: string, outputTokens = 5) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    result,
    usage: { input_tokens: 10, output_tokens: outputTokens },
  });

describe("CLI output parsers", () => {
  it("extracts text from Claude --output-format json envelope (fixture)", () => {
    const stdout = readFileSync(
      join(fixturesDir, "claude-cli-output.json"),
      "utf8",
    );

    expect(parseClaudeCliOutput(stdout)).toBe("hello");
  });

  it("extracts text from Codex JSONL agent message output", () => {
    const stdout = readFileSync(
      join(fixturesDir, "codex-cli-output.jsonl"),
      "utf8",
    );

    expect(parseCodexCliOutput(stdout)).toBe("hello");
  });

  it("extracts output token count from Claude envelope", () => {
    expect(extractClaudeTokenUsage(claudeEnvelope("hello", 42))).toBe(42);
  });

  it("extracts batch translations from Claude envelope JSON", () => {
    const stdout = claudeEnvelope(
      JSON.stringify({
        translations: [
          { id: "row-1", text: "Bonjour" },
          { id: "row-2", text: "Salut" },
        ],
      }),
    );

    expect(parseClaudeBatchCliOutput(stdout)).toEqual([
      { id: "row-1", text: "Bonjour" },
      { id: "row-2", text: "Salut" },
    ]);
  });

  it("passes empty-text and duplicate items through and skips malformed entries", () => {
    // Per-item acceptance belongs to the validation layer; the parser must
    // not fail valid siblings because of one bad item.
    const stdout = claudeEnvelope(
      JSON.stringify({
        translations: [
          { id: "row-1", text: "" },
          { id: "", text: "missing id" },
          { text: "no id at all" },
          { id: "row-1", text: "duplicate" },
          { id: "row-2", text: " ok " },
        ],
      }),
    );

    expect(parseClaudeBatchCliOutput(stdout)).toEqual([
      { id: "row-1", text: "" },
      { id: "row-1", text: "duplicate" },
      { id: "row-2", text: "ok" },
    ]);
  });

  it("rejects batch output without a translations array", () => {
    const stdout = claudeEnvelope(JSON.stringify({ items: [] }));

    expect(() => parseClaudeBatchCliOutput(stdout)).toThrow(CliOutputError);
  });

  it("extracts batch translations from Codex JSONL agent message", () => {
    const payload = JSON.stringify({
      translations: [{ id: "row-1", text: "Bonjour" }],
    });
    const stdout = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: payload },
    });

    expect(parseCodexBatchCliOutput(stdout)).toEqual([
      { id: "row-1", text: "Bonjour" },
    ]);
  });

  it("returns 0 token count when usage field is absent", () => {
    expect(
      extractClaudeTokenUsage(JSON.stringify({ type: "result", result: "hi" })),
    ).toBe(0);
  });

  it("rejects empty translated text in Claude envelope", () => {
    expect(() => parseClaudeCliOutput(claudeEnvelope("   "))).toThrow(CliOutputError);
  });

  it("rejects Claude output that is not a result envelope", () => {
    expect(() => parseClaudeCliOutput('{"type":"error","message":"bad"}')).toThrow(
      CliOutputError,
    );
  });

  it("rejects non-JSON Claude output", () => {
    expect(() => parseClaudeCliOutput("Here is the translation: hello")).toThrow(
      CliOutputError,
    );
  });

  it("rejects Codex JSONL with no agent message", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.completed"}',
    ].join("\n");

    expect(() => parseCodexCliOutput(stdout)).toThrow(CliOutputError);
  });

  it("marks parser failures with invalid_output code", () => {
    try {
      parseClaudeCliOutput("not json");
      throw new Error("expected parser to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliOutputError);
      expect((err as CliOutputError).code).toBe("invalid_output");
    }
  });
});
