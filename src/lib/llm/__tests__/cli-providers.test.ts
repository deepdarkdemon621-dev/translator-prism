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

  const chapterRequest = (items: { id: string; seq: number; text: string }[]) => ({
    bookTitle: "テスト書",
    chapterTitle: "序章",
    sourceLang: "ja",
    targetLang: "zh",
    items,
  });

  it("translates a chapter batch with one Claude CLI call", async () => {
    mockedRunCli.mockResolvedValue({
      stdout: claudeEnvelope(
        JSON.stringify({
          translations: [
            { id: "row-1", text: "你好" },
            { id: "row-2", text: "再见" },
          ],
        }),
        9,
      ),
      stderr: "",
    });

    const result = await new ClaudeCodeCliProvider().translateBatch(
      chapterRequest([
        { id: "row-1", seq: 0, text: "こんにちは" },
        { id: "row-2", seq: 1, text: "さようなら" },
      ]),
    );

    expect(mockedRunCli).toHaveBeenCalledTimes(1);
    const stdin = mockedRunCli.mock.calls[0][0].stdin as string;
    expect(stdin).toContain("テスト書");
    expect(stdin).toContain("序章");
    expect(stdin).toContain("Chinese");
    expect(stdin).toContain('"id":"row-1"');
    expect(stdin).toContain('"seq":1');
    expect(result).toEqual([
      { id: "row-1", text: "你好", tokensUsed: 5, model: "claude-code:sonnet" },
      { id: "row-2", text: "再见", tokensUsed: 5, model: "claude-code:sonnet" },
    ]);
  });

  it("returns unknown or partial Claude batch items for the validation layer", async () => {
    mockedRunCli.mockResolvedValue({
      stdout: claudeEnvelope(
        JSON.stringify({ translations: [{ id: "unexpected", text: "??" }] }),
      ),
      stderr: "",
    });

    const result = await new ClaudeCodeCliProvider().translateBatch(
      chapterRequest([{ id: "row-1", seq: 0, text: "こんにちは" }]),
    );

    expect(result.map((item) => item.id)).toEqual(["unexpected"]);
  });

  it("throws when a Claude batch contains no translations at all", async () => {
    mockedRunCli.mockResolvedValue({
      stdout: claudeEnvelope(JSON.stringify({ translations: [] })),
      stderr: "",
    });

    await expect(
      new ClaudeCodeCliProvider().translateBatch(
        chapterRequest([{ id: "row-1", seq: 0, text: "こんにちは" }]),
      ),
    ).rejects.toThrow(/no translations/);
  });

  it("scales the Claude batch timeout with item count", async () => {
    process.env.CLAUDE_CODE_TIMEOUT_MS = "100000";
    process.env.CLAUDE_CODE_BATCH_ITEM_TIMEOUT_MS = "5000";
    mockedRunCli.mockResolvedValue({
      stdout: claudeEnvelope(
        JSON.stringify({ translations: [{ id: "row-1", text: "你好" }] }),
      ),
      stderr: "",
    });

    await new ClaudeCodeCliProvider().translateBatch(
      chapterRequest([
        { id: "row-1", seq: 0, text: "一" },
        { id: "row-2", seq: 1, text: "二" },
        { id: "row-3", seq: 2, text: "三" },
      ]),
    );

    expect(mockedRunCli.mock.calls[0][0].timeoutMs).toBe(100_000 + 2 * 5000);
    delete process.env.CLAUDE_CODE_TIMEOUT_MS;
    delete process.env.CLAUDE_CODE_BATCH_ITEM_TIMEOUT_MS;
  });

  it("translates a chapter batch with one Codex CLI call", async () => {
    process.env.CODEX_CLI_ENABLED = "true";
    process.env.CODEX_CLI_MODEL = "gpt-5.6-sol";
    const payload = JSON.stringify({
      translations: [
        { id: "row-1", text: "你好" },
        { id: "row-2", text: "再见" },
      ],
    });
    mockedRunCli.mockResolvedValue({
      stdout: JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: payload },
      }),
      stderr: "",
    });

    const result = await new CodexCliProvider().translateBatch(
      chapterRequest([
        { id: "row-1", seq: 0, text: "こんにちは" },
        { id: "row-2", seq: 1, text: "さようなら" },
      ]),
    );

    expect(mockedRunCli).toHaveBeenCalledTimes(1);
    const call = mockedRunCli.mock.calls[0][0];
    expect(call.args).toContain("exec");
    expect(call.args).toContain("read-only");
    expect(call.args).toContain("--ephemeral");
    expect(call.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(call.stdin).toContain("テスト書");
    expect(result).toEqual([
      { id: "row-1", text: "你好", tokensUsed: 0, model: "codex:gpt-5.6-sol" },
      { id: "row-2", text: "再见", tokensUsed: 0, model: "codex:gpt-5.6-sol" },
    ]);
  });
});
