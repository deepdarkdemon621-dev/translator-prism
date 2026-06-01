import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CliOutputError,
  extractClaudeTokenUsage,
  parseClaudeCliOutput,
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
