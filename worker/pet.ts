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

type PetEnv = {
  WORKER_PET?: string;
  CI?: string;
  [key: string]: string | undefined;
};
type SetTimeoutFn = (callback: () => void, delay: number) => NodeJS.Timeout;
type ClearTimeoutFn = (handle: NodeJS.Timeout) => void;

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
    " /\\_/\\\n( o.o )\n > ^ <\n =   =",
    "  /\\_/\\\n ( o.o )\n  > ^ <\n  =   =",
  ],
  blink: [
    " /\\_/\\\n( o.o )\n > ^ <\n =   =",
    " /\\_/\\\n( -.- )\n > ^ <\n =   =",
  ],
  working: [
    " /\\_/\\  ..\n( >.< ) ...\n > ^ <\n =   =",
    " /\\_/\\ ...\n( >.< )  ..\n > - <\n =   =",
  ],
  thinking: [
    "   ?\n /\\_/\\\n( o.o )\n > ? <\n =   =",
  ],
  sleep: [
    "   z\n /\\_/\\\n( -.- )\n > _ <\n =   =",
  ],
  cheer: [
    "\\ /\\_/\\ /\n ( ^.^ )\n  > v <\n  =   =",
  ],
  error: [
    "   !\n /\\_/\\\n( !.! )\n > o <\n =   =",
    "  !\n/\\_/\\\n( !.! )\n> o <\n=   =",
  ],
  hide: [
    " /\\_/\\\n( -.- )\n >_<\n = =",
    " /\\_/\\\n( o.o )\n > ^ <\n =   =",
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

export type WorkerPetEvent = "working" | "error";

export interface WorkerPet {
  notify(event: WorkerPetEvent): void;
  stop(): void;
}

interface StartWorkerPetOptions {
  env?: PetEnv;
  isTTY?: boolean;
  random?: () => number;
  write?: (value: string) => void;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
}

const FRAME_INTERVAL_MS = 240;
const ACTION_DELAY_MIN_MS = 3_000;
const ACTION_DELAY_SPREAD_MS = 5_000;

export function startWorkerPet({
  env = process.env,
  isTTY = Boolean(process.stdout.isTTY),
  random = Math.random,
  write = (value) => process.stdout.write(value),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}: StartWorkerPetOptions = {}): WorkerPet {
  if (getPetMode({ env, isTTY }) === "off") {
    return { notify() {}, stop() {} };
  }

  let stopped = false;
  let handle: NodeJS.Timeout | undefined;
  let linesDrawn = 0;
  let bias: PetBias | undefined;

  const clear = () => {
    if (linesDrawn === 0) return;
    write(`\u001b[${linesDrawn}A\u001b[J`);
    linesDrawn = 0;
  };

  const render = (frame: string) => {
    clear();
    const output = `[worker-pet]\n${frame}\n`;
    write(output);
    linesDrawn = output.split("\n").length - 1;
  };

  const schedule = (delay: number) => {
    handle = setTimeoutFn(runAction, delay);
  };

  const runFrame = (frames: string[], index: number) => {
    if (stopped) return;
    render(frames[index]);
    if (index + 1 < frames.length) {
      handle = setTimeoutFn(() => runFrame(frames, index + 1), FRAME_INTERVAL_MS);
      return;
    }
    const nextDelay = ACTION_DELAY_MIN_MS + Math.floor(random() * ACTION_DELAY_SPREAD_MS);
    schedule(nextDelay);
  };

  const runAction = () => {
    if (stopped) return;
    const action = choosePetAction(random, bias);
    bias = undefined;
    runFrame(getPetFrames(action), 0);
  };

  const safeRunAction = () => {
    try {
      runAction();
    } catch {
      stopped = true;
    }
  };

  safeRunAction();

  return {
    notify(event) {
      bias = event;
      if (handle) clearTimeoutFn(handle);
      safeRunAction();
    },
    stop() {
      stopped = true;
      if (handle) clearTimeoutFn(handle);
      try {
        clear();
      } catch {
        // Pet rendering must never affect worker shutdown.
      }
    },
  };
}
