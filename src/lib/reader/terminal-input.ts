export type TerminalInput = {
  isTTY?: boolean;
  setRawMode?: (enabled: boolean) => void;
  resume: () => unknown;
};

export type TerminalPageKeyAction = "next-page" | "previous-page";

export type TerminalKey = {
  name?: string;
};

export function restoreTerminalInput(
  input: TerminalInput,
  rawMode: boolean,
): void {
  if (input.isTTY && input.setRawMode) {
    input.setRawMode(rawMode);
  }
  input.resume();
}

export function getTerminalPageKeyAction(
  key: TerminalKey,
): TerminalPageKeyAction | undefined {
  if (key.name === "n" || key.name === "right" || key.name === "down") {
    return "next-page";
  }
  if (key.name === "p" || key.name === "left" || key.name === "up") {
    return "previous-page";
  }
  return undefined;
}
