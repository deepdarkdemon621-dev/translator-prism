import { describe, expect, it, vi } from "vitest";
import {
  getTerminalPageKeyAction,
  restoreTerminalInput,
} from "@/lib/reader/terminal-input";

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

  it("maps page navigation keys including arrow keys", () => {
    expect(getTerminalPageKeyAction({ name: "n" })).toBe("next-page");
    expect(getTerminalPageKeyAction({ name: "right" })).toBe("next-page");
    expect(getTerminalPageKeyAction({ name: "down" })).toBe("next-page");

    expect(getTerminalPageKeyAction({ name: "p" })).toBe("previous-page");
    expect(getTerminalPageKeyAction({ name: "left" })).toBe("previous-page");
    expect(getTerminalPageKeyAction({ name: "up" })).toBe("previous-page");

    expect(getTerminalPageKeyAction({ name: "q" })).toBeUndefined();
  });
});
