import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../cli-runner";
import { ClaudeCodeCliProvider, CodexCliProvider } from "../cli-providers";

vi.mock("../cli-runner", () => ({
  runCli: vi.fn(),
}));

const mockedRunCli = vi.mocked(runCli);

describe("CLI providers", () => {
  const claudeEnvelope = (result: string, outputTokens = 5) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      result,
      usage: { input_tokens: 10, output_tokens: outputTokens },
    });

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.CLAUDE_CODE_BARE;
    delete process.env.CLAUDE_CODE_MAX_BUDGET_USD;
    delete process.env.CLAUDE_CODE_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CODEX_CLI_ALLOW_BYPASS;
    delete process.env.CODEX_CLI_ENABLED;
    delete process.env.CODEX_CLI_MODEL;
    mockedRunCli.mockResolvedValue({
      stdout: claudeEnvelope("Bonjour", 7),
      stderr: "",
    });
  });

  it("adds Claude --bare only when enabled", async () => {
    process.env.CLAUDE_CODE_BARE = "true";

    await new ClaudeCodeCliProvider().translate("hello", "en", "fr");

    expect(mockedRunCli.mock.calls[0][0].args).toContain("--bare");
  });

  it("omits Claude --bare by default", async () => {
    await new ClaudeCodeCliProvider().translate("hello", "en", "fr");

    expect(mockedRunCli.mock.calls[0][0].args).not.toContain("--bare");
  });

  it("removes external Anthropic API key from Claude subscription-mode calls", async () => {
    process.env.ANTHROPIC_API_KEY = "invalid-api-key";

    await new ClaudeCodeCliProvider().translate("hello", "en", "fr");

    expect(mockedRunCli.mock.calls[0][0].env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("keeps external Anthropic API key for Claude bare-mode calls", async () => {
    process.env.CLAUDE_CODE_BARE = "true";
    process.env.ANTHROPIC_API_KEY = "api-key-for-bare-mode";

    await new ClaudeCodeCliProvider().translate("hello", "en", "fr");

    expect(mockedRunCli.mock.calls[0][0].env?.ANTHROPIC_API_KEY).toBe(
      "api-key-for-bare-mode",
    );
  });

  it("adds Claude budget only when configured", async () => {
    process.env.CLAUDE_CODE_MAX_BUDGET_USD = "0.03";

    await new ClaudeCodeCliProvider().translate("hello", "en", "fr");

    expect(mockedRunCli.mock.calls[0][0].args).toContain("--max-budget-usd");
    expect(mockedRunCli.mock.calls[0][0].args).toContain("0.03");
  });

  it("requires explicit Codex enablement", () => {
    expect(() => new CodexCliProvider()).toThrow("CODEX_CLI_ENABLED=true");
  });

  it("adds Codex bypass only when enabled", async () => {
    process.env.CODEX_CLI_ENABLED = "true";
    process.env.CODEX_CLI_ALLOW_BYPASS = "true";
    mockedRunCli.mockResolvedValue({
      stdout:
        '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"text\\":\\"Bonjour\\"}"}}\n',
      stderr: "",
    });

    await new CodexCliProvider().translate("hello", "en", "fr");

    expect(mockedRunCli.mock.calls[0][0].args).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  });

  it("does not pass an unsupported Codex default model", async () => {
    process.env.CODEX_CLI_ENABLED = "true";
    mockedRunCli.mockResolvedValue({
      stdout:
        '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"text\\":\\"Bonjour\\"}"}}\n',
      stderr: "",
    });

    await new CodexCliProvider().translate("hello", "en", "fr");

    expect(mockedRunCli.mock.calls[0][0].args).not.toContain("-m");
  });

  it("returns token usage from Claude envelope", async () => {
    const result = await new ClaudeCodeCliProvider().translate("hello", "en", "fr");

    expect(result).toMatchObject({
      text: "Bonjour",
      tokensUsed: 7,
      model: "claude-code:sonnet",
    });
  });
});
