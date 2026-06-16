export type TerminalInput = {
  isTTY?: boolean;
  setRawMode?: (enabled: boolean) => void;
  resume: () => unknown;
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
