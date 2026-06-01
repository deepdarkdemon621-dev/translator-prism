import { classifyLLMError, type LLMErrorCode } from "./errors";
import type { LLMProvider, TranslationResult } from "./types";

export interface ProviderAttemptFailure {
  providerName: string;
  code: LLMErrorCode;
  message: string;
}

export class ProviderChainError extends Error {
  constructor(
    readonly attempts: ProviderAttemptFailure[],
    readonly finalProvider: string | null,
    readonly finalCode: LLMErrorCode,
  ) {
    super(
      `All providers failed: ${attempts
        .map((attempt) => `${attempt.providerName}:${attempt.code}`)
        .join(", ")}`,
    );
  }
}

export const disabledProviders = new Set<string>();

const PERMANENT_DISABLE_CODES: LLMErrorCode[] = [
  "quota_exhausted",
  "auth_error",
  "model_not_found",
];

const providerSemaphores = new Map<string, Semaphore>();

export class ProviderChain implements LLMProvider {
  name = "provider-chain";

  constructor(private readonly providers: LLMProvider[]) {}

  async translate(
    text: string,
    fromLang: string,
    toLang: string,
    model?: string,
  ): Promise<TranslationResult> {
    const attempts: ProviderAttemptFailure[] = [];

    for (const provider of this.providers) {
      if (disabledProviders.has(provider.name)) continue;

      try {
        const result = await runWithProviderLimit(provider, () =>
          provider.translate(text, fromLang, toLang, model),
        );
        return result.model.includes(":")
          ? result
          : { ...result, model: `${provider.name}:${result.model}` };
      } catch (err) {
        const classified = classifyLLMError(err);
        attempts.push({
          providerName: provider.name,
          code: classified.code,
          message: classified.raw,
        });

        if (PERMANENT_DISABLE_CODES.includes(classified.code)) {
          disabledProviders.add(provider.name);
        }
      }
    }

    const final = attempts.at(-1);
    throw new ProviderChainError(
      attempts,
      final?.providerName ?? null,
      final?.code ?? "unknown",
    );
  }
}

async function runWithProviderLimit<T>(
  provider: LLMProvider,
  operation: () => Promise<T>,
): Promise<T> {
  const limit = getProviderConcurrencyLimit(provider.name);
  if (!limit) return operation();

  let semaphore = providerSemaphores.get(provider.name);
  if (!semaphore || semaphore.limit !== limit) {
    // PM2 --update-env restarts the process, which clears this map. The
    // replacement path mainly keeps tests and same-process env reloads honest;
    // in-flight waiters on an older semaphore may finish under the old limit.
    semaphore = new Semaphore(limit);
    providerSemaphores.set(provider.name, semaphore);
  }

  await semaphore.acquire();
  try {
    return await operation();
  } finally {
    semaphore.release();
  }
}

function getProviderConcurrencyLimit(providerName: string): number | null {
  if (providerName === "claude-code") {
    return Number(process.env.CLAUDE_CODE_CONCURRENCY ?? 1);
  }
  if (providerName === "codex") {
    return Number(process.env.CODEX_CLI_CONCURRENCY ?? 1);
  }
  return null;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
