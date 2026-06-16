import { describe, expect, it, vi } from "vitest";
import { restoreTerminalInput } from "@/lib/reader/terminal-input";

describe("terminal input helpers", () => {
  it("resumes stdin after restoring raw mode", () => {
    const input = {
      isTTY: true,
      setRawMode: vi.fn(),
      resume: vi.fn(),
    };

    restoreTerminalInput(input, true);

    expect(input.setRawMode).toHaveBeenCalledWith(true);
    expect(input.resume).toHaveBeenCalledTimes(1);
  });

  it("still resumes non-TTY input without setting raw mode", () => {
    const input = {
      isTTY: false,
      setRawMode: vi.fn(),
      resume: vi.fn(),
    };

    restoreTerminalInput(input, true);

    expect(input.setRawMode).not.toHaveBeenCalled();
    expect(input.resume).toHaveBeenCalledTimes(1);
  });
});
