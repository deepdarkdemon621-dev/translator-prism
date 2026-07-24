import { classifyLLMError, type LLMErrorCode } from "./errors";
import type {
  ChapterBatchRequest,
  LLMProvider,
  TranslationBatchResult,
  TranslationResult,
} from "./types";

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
    readonly skippedUnavailableProviders: string[] = [],
  ) {
    super(
      formatProviderChainErrorMessage(attempts, skippedUnavailableProviders),
    );
  }
}

function formatProviderChainErrorMessage(
  attempts: ProviderAttemptFailure[],
  skippedUnavailableProviders: string[],
): string {
  const failed = attempts.map((attempt) => `${attempt.providerName}:${attempt.code}`);
  if (failed.length === 0) {
    const skipped =
      skippedUnavailableProviders.length > 0
        ? `; skipped unavailable providers: ${skippedUnavailableProviders.join(", ")}`
        : "";
    return `No providers ran${skipped}`;
  }

  const skipped =
    skippedUnavailableProviders.length > 0
      ? `; skipped unavailable providers: ${skippedUnavailableProviders.join(", ")}`
      : "";
  return `All providers failed: ${failed.join(", ")}${skipped}`;
}

export const disabledProviders = new Set<string>();

const PERMANENT_DISABLE_CODES: LLMErrorCode[] = [
  "quota_exhausted",
  "auth_error",
  "model_not_found",
];

const CLAUDE_EXCLUSIVE_RETRY_CODES: LLMErrorCode[] = [
  "quota_exhausted",
  "rate_limit",
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
    const skippedUnavailableProviders: string[] = [];

    for (const provider of this.providers) {
      if (disabledProviders.has(provider.name)) continue;

      while (true) {
        // Providers without isAvailable() are always eligible.
        if (provider.isAvailable && !provider.isAvailable()) {
          skippedUnavailableProviders.push(provider.name);
          break;
        }

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

          if (shouldRetryClaudeExclusive(provider, classified.code)) {
            const retryDelayMs = getClaudeExclusiveRetryDelayMs();
            console.warn(
              `[provider-chain] Claude exclusive window: ${classified.code}; retrying claude-code in ${retryDelayMs}ms instead of falling through`,
            );
            await sleep(retryDelayMs);
            continue;
          }

          if (PERMANENT_DISABLE_CODES.includes(classified.code)) {
            disabledProviders.add(provider.name);
          }
          break;
        }
      }
    }

    const final = attempts.at(-1);
    throw new ProviderChainError(
      attempts,
      final?.providerName ?? null,
      final?.code ?? "unknown",
      skippedUnavailableProviders,
    );
  }

  async translateBatch(
    request: ChapterBatchRequest,
    model?: string,
  ): Promise<TranslationBatchResult[]> {
    const attempts: ProviderAttemptFailure[] = [];
    const skippedUnavailableProviders: string[] = [];

    for (const provider of this.providers) {
      if (disabledProviders.has(provider.name)) continue;

      while (true) {
        if (provider.isAvailable && !provider.isAvailable()) {
          skippedUnavailableProviders.push(provider.name);
          break;
        }

        try {
          const results = await runWithProviderLimit(provider, async () => {
            if (provider.translateBatch) {
              return provider.translateBatch(request, model);
            }
            const translated: TranslationBatchResult[] = [];
            for (const item of request.items) {
              const result = await provider.translate(
                item.text,
                request.sourceLang,
                request.targetLang,
                model,
              );
              translated.push({ ...result, id: item.id });
            }
            return translated;
          });
          return results.map((result) =>
            result.model.includes(":")
              ? result
              : { ...result, model: `${provider.name}:${result.model}` },
          );
        } catch (err) {
          const classified = classifyLLMError(err);
          attempts.push({
            providerName: provider.name,
            code: classified.code,
            message: classified.raw,
          });

          if (shouldRetryClaudeExclusive(provider, classified.code)) {
            const retryDelayMs = getClaudeExclusiveRetryDelayMs();
            console.warn(
              `[provider-chain] Claude exclusive window: ${classified.code}; retrying claude-code in ${retryDelayMs}ms instead of falling through`,
            );
            await sleep(retryDelayMs);
            continue;
          }

          if (PERMANENT_DISABLE_CODES.includes(classified.code)) {
            disabledProviders.add(provider.name);
          }
          break;
        }
      }
    }

    const final = attempts.at(-1);
    throw new ProviderChainError(
      attempts,
      final?.providerName ?? null,
      final?.code ?? "unknown",
      skippedUnavailableProviders,
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

function shouldRetryClaudeExclusive(
  provider: LLMProvider,
  code: LLMErrorCode,
): boolean {
  return (
    provider.name === "claude-code" &&
    process.env.CLAUDE_CODE_EXCLUSIVE_WITHIN_WINDOW === "true" &&
    CLAUDE_EXCLUSIVE_RETRY_CODES.includes(code) &&
    (!provider.isAvailable || provider.isAvailable())
  );
}

function getClaudeExclusiveRetryDelayMs(): number {
  return Number(process.env.CLAUDE_CODE_EXCLUSIVE_RETRY_DELAY_MS ?? 60_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
