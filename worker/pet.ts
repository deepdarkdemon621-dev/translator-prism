export const PET_ACTIONS = [
  "float",
  "blink",
  "working",
  "thinking",
  "sleep",
  "cheer",
  "error",
  "hide",
] as const;

export type PetAction = (typeof PET_ACTIONS)[number];
export type PetBias = "working" | "error";
export type PetMode = "animate" | "off";

type PetEnv = Pick<NodeJS.ProcessEnv, "WORKER_PET" | "CI">;

export function getPetMode({
  env = process.env,
  isTTY = Boolean(process.stdout.isTTY),
}: {
  env?: PetEnv;
  isTTY?: boolean;
} = {}): PetMode {
  if (env.WORKER_PET === "0") return "off";
  if (env.WORKER_PET === "1") return "animate";
  if (env.CI) return "off";
  return isTTY ? "animate" : "off";
}

const FRAMES: Record<PetAction, string[]> = {
  float: [
    "   .\n  / \\\n /   \\\n( o o )\n \\ ^ /\n  \\_/\n '~~~'",
    "    .\n   / \\\n  /   \\\n ( o o )\n  \\ ^ /\n   \\_/\n  '~~~'",
  ],
  blink: [
    "   .\n  / \\\n /   \\\n( o o )\n \\ ^ /\n  \\_/\n '~~~'",
    "   .\n  / \\\n /   \\\n( - - )\n \\ ^ /\n  \\_/\n '~~~'",
  ],
  working: [
    "   .    .\n  / \\   ..\n /   \\  ...\n( > < )\n \\ ^ /\n  \\_/\n '~~~'",
    "   .    ..\n  / \\   ...\n /   \\  .\n( > < )\n \\ - /\n  \\_/\n '~~~'",
  ],
  thinking: [
    "   ?\n   .\n  / \\\n /   \\\n( o o )\n \\ ? /\n  \\_/\n '~~~'",
  ],
  sleep: [
    "   z\n   .\n  / \\\n /   \\\n( - - )\n \\ _ /\n  \\_/\n '~~~'",
  ],
  cheer: [
    " \\ . /\n  / \\\n /   \\\n( ^ ^ )\n \\ v /\n  \\_/\n '~~~'",
  ],
  error: [
    "   !\n   .\n  / \\\n /   \\\n( ! ! )\n \\ o /\n  \\_/\n '~~~'",
    "  !\n  .\n / \\\n/   \\\n( ! ! )\n\\ o /\n \\_/\n'~~~'",
  ],
  hide: [
    "   .\n  / \\\n ( - - )\n  \\_/\n '~~~'",
    "   .\n  / \\\n /   \\\n( o o )\n \\ ^ /\n  \\_/\n '~~~'",
  ],
};

export function getPetFrames(action: PetAction): string[] {
  return FRAMES[action];
}

export function choosePetAction(
  random: () => number = Math.random,
  bias?: PetBias,
): PetAction {
  if (bias === "working" && random() < 0.5) return "working";
  if (bias === "error" && random() < 0.7) return "error";
  const index = Math.min(Math.floor(random() * PET_ACTIONS.length), PET_ACTIONS.length - 1);
  return PET_ACTIONS[index];
}
