import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CliOutputError,
  parseClaudeCliOutput,
  parseCodexCliOutput,
} from "../cli-output";

const fixturesDir = join(__dirname, "..", "__fixtures__");

describe("CLI output parsers", () => {
  it("extracts text from Claude JSON output", () => {
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

  it("accepts fenced JSON from Claude", () => {
    expect(parseClaudeCliOutput('```json\n{"text":"hello"}\n```')).toBe(
      "hello",
    );
  });

  it("rejects empty translated text", () => {
    expect(() => parseClaudeCliOutput('{"text":"   "}')).toThrow(CliOutputError);
  });

  it("rejects non-JSON Claude explanations", () => {
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
