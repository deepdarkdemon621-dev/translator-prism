const RECOVERABLE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

type WorkerErrorLike = {
  cause?: unknown;
  code?: unknown;
  errno?: unknown;
};

export type RecoverableWorkerStepResult<T> =
  | { ok: true; value: T }
  | { ok: false };

export function isRecoverableWorkerError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as WorkerErrorLike;

  if (typeof err.code === "string" && RECOVERABLE_ERROR_CODES.has(err.code)) {
    return true;
  }

  if (typeof err.errno === "string" && RECOVERABLE_ERROR_CODES.has(err.errno)) {
    return true;
  }

  return isRecoverableWorkerError(err.cause);
}

export async function runRecoverableWorkerStep<T>({
  label,
  operation,
  onRecoverableError,
  retryDelayMs,
  sleep,
}: {
  label: string;
  operation: () => Promise<T>;
  onRecoverableError: (label: string, error: unknown, retryDelayMs: number) => void;
  retryDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<RecoverableWorkerStepResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (err) {
    if (!isRecoverableWorkerError(err)) {
      throw err;
    }

    onRecoverableError(label, err, retryDelayMs);
    await sleep(retryDelayMs);
    return { ok: false };
  }
}
