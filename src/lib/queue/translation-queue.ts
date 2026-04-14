import fs from "fs";
import path from "path";
import type { LLMProvider, TranslationResult } from "../llm/types";
import { createProvider } from "../llm/factory";

const SETTINGS_PATH = path.join(process.cwd(), "data", "settings.json");

interface LLMSettings {
  provider: string;
  apiKey: string;
  concurrency: number;
}

function loadLLMSettings(): LLMSettings {
  try {
    const data = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(data);
    return {
      provider: parsed.llm?.provider ?? "claude",
      apiKey: parsed.llm?.apiKey ?? "",
      concurrency: parsed.llm?.concurrency ?? 2,
    };
  } catch {
    return { provider: "claude", apiKey: "", concurrency: 2 };
  }
}

/**
 * Name of the currently-configured LLM provider. Used by the batch
 * translate-all routes to decide whether to show a cost-confirmation gate
 * (paid APIs) or just fire (local Ollama). Stays in sync with whatever
 * settings.json holds without exposing the api key.
 */
export function getActiveProviderName(): string {
  return loadLLMSettings().provider;
}

/**
 * True when the active provider doesn't cost money per call (local Ollama).
 * The cost-gate short-circuits for these.
 */
export function isLocalProvider(): boolean {
  return getActiveProviderName() === "ollama";
}

export interface TranslationJob {
  translationId: string;
  text: string;
  fromLang: string;
  toLang: string;
  model?: string;
  onComplete: (result: TranslationResult) => void;
  onError: (error: Error) => void;
  /** Optional pre-flight check. If returns false when the queue is about
   * to run this job, the job is skipped silently (no provider call, no
   * onComplete/onError). Used by the cancel endpoint: marks rows as
   * 'cancelled' in DB, and shouldRun peeks DB status before each run. */
  shouldRun?: () => boolean;
}

export class TranslationQueue {
  private provider: LLMProvider;
  private queue: TranslationJob[] = [];
  private running = 0;
  private concurrency: number;
  private idleResolvers: (() => void)[] = [];

  constructor(provider: LLMProvider, options: { concurrency: number } = { concurrency: 2 }) {
    this.provider = provider;
    this.concurrency = options.concurrency;
  }

  add(job: TranslationJob): void {
    this.queue.push(job);
    this.processNext();
  }

  get pending(): number {
    return this.queue.length;
  }

  get activeCount(): number {
    return this.running;
  }

  async onIdle(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return;
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  updateProvider(provider: LLMProvider): void {
    this.provider = provider;
  }

  private async processNext(): Promise<void> {
    if (this.running >= this.concurrency || this.queue.length === 0) return;

    const job = this.queue.shift()!;
    this.running++;

    try {
      // Cancellation check: the row may have been marked 'cancelled' in DB
      // while the job was sitting in queue. Skip the provider call — the
      // callbacks are also skipped, so the cancelled status stays put.
      if (job.shouldRun && !job.shouldRun()) {
        return;
      }
      const result = await this.provider.translate(job.text, job.fromLang, job.toLang, job.model);
      job.onComplete(result);
    } catch (err) {
      job.onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.running--;
      this.processNext();
      if (this.running === 0 && this.queue.length === 0) {
        this.idleResolvers.forEach((r) => r());
        this.idleResolvers = [];
      }
    }
  }
}

let _queue: TranslationQueue | null = null;

export function getTranslationQueue(): TranslationQueue {
  if (!_queue) {
    const settings = loadLLMSettings();
    // Env var takes precedence over settings.json for the default Claude provider
    // (backwards-compat with existing deployments using ANTHROPIC_API_KEY)
    const apiKey =
      settings.provider === "claude" && process.env.ANTHROPIC_API_KEY
        ? process.env.ANTHROPIC_API_KEY
        : settings.apiKey;
    const provider = createProvider(settings.provider, apiKey);
    _queue = new TranslationQueue(provider, { concurrency: settings.concurrency });
  }
  return _queue;
}

export function resetTranslationQueue(): void {
  _queue = null;
}
