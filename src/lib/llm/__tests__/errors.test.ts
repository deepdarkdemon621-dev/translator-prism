import { describe, expect, it } from "vitest";
import { classifyLLMError, parseErrorCode } from "../errors";

describe("LLM error classification", () => {
  it("classifies Claude CLI budget exhaustion as quota_exhausted", () => {
    const classified = classifyLLMError(
      new Error('Reached maximum budget ($0.01)'),
    );

    expect(classified.code).toBe("quota_exhausted");
  });

  it("classifies Claude Code usage-limit reset messages as quota_exhausted", () => {
    const classified = classifyLLMError(
      new Error("Claude AI usage limit reached. Your limit will reset at 8:00 PM."),
    );

    expect(classified.code).toBe("quota_exhausted");
  });

  it("classifies CLI auth prompts as auth_error", () => {
    const classified = classifyLLMError(
      new Error("Authentication required. Please log in to continue."),
    );

    expect(classified.code).toBe("auth_error");
  });

  it("classifies CLI process timeout as network", () => {
    const classified = classifyLLMError(
      new Error("CLI process timed out after 120000ms"),
    );

    expect(classified.code).toBe("network");
  });

  it("classifies invalid CLI output using the error code property", () => {
    const err = new Error("Expected JSON object with a non-empty text string") as Error & {
      code: string;
    };
    err.code = "invalid_output";

    const classified = classifyLLMError(err);

    expect(classified.code).toBe("invalid_output");
  });

  it("parses invalid_output from stored error messages", () => {
    expect(parseErrorCode("[invalid_output] CLI returned invalid output")).toBe(
      "invalid_output",
    );
  });

  it("classifies Codex JSONL model errors from non-zero exits", () => {
    const classified = classifyLLMError(
      new Error(
        '{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The o3 model is not supported when using Codex with a ChatGPT account.\\"}}"}',
      ),
    );

    expect(classified.code).toBe("model_not_found");
  });
});
