/**
 * Classify an LLM provider error into an actionable code + friendly hint.
 *
 * We store the classification as `[code] friendly — raw` in
 * `translations.error_message`. The /progress page parses the `[code]`
 * prefix to decide whether to show the quota-exhausted banner without
 * having to NLP the raw provider text.
 *
 * Keep the code list small and ordered from "loudest" (blocks further
 * progress — quota / auth) to "probably transient" (network) — when the
 * recent-failure sample is mixed, the first-match code wins.
 */
export type LLMErrorCode =
  | "quota_exhausted"
  | "rate_limit"
  | "auth_error"
  | "model_not_found"
  | "network"
  | "invalid_output"
  | "unknown";

export interface ClassifiedLLMError {
  code: LLMErrorCode;
  friendly: string;
  /** Short raw tail for debugging — first ~120 chars of the original. */
  raw: string;
}

export function classifyLLMError(err: unknown): ClassifiedLLMError {
  const raw = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  const lower = raw.toLowerCase();

  if ((err as { code?: string }).code === "invalid_output") {
    return {
      code: "invalid_output",
      friendly: "CLI returned invalid translation output",
      raw,
    };
  }

  // Quota: the account is out of money / hit monthly cap. User needs to
  // top up before Retry makes any difference. OpenAI's exact string is
  // "You exceeded your current quota, please check your plan and billing";
  // Anthropic's is "credit balance is too low to access the Anthropic API".
  // "insufficient_quota" is OpenAI's machine-readable error type.
  if (
    lower.includes("insufficient_quota") ||
    lower.includes("credit balance is too low") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("you have exceeded your budget") ||
    lower.includes("quota exceeded") ||
    lower.includes("budget exceeded") ||
    lower.includes("maximum budget") ||
    lower.includes("max budget") ||
    lower.includes("--max-budget-usd")
  ) {
    return {
      code: "quota_exhausted",
      friendly: "额度不够，请充值后点 Retry failed 继续",
      raw,
    };
  }

  // Auth: invalid key, revoked, missing. Distinct from quota — no amount
  // of waiting or topping-up helps; user has to fix the key in /settings.
  // Check before the 401 branch so this wins when both keywords appear.
  if (
    lower.includes("invalid_api_key") ||
    lower.includes("incorrect api key") ||
    lower.includes("invalid x-api-key") ||
    lower.includes("authentication_error") ||
    lower.includes("no auth credentials") ||
    lower.includes("login required") ||
    lower.includes("not authenticated") ||
    lower.includes("authentication required") ||
    lower.includes("please log in") ||
    lower.includes("unauthorized")
  ) {
    return {
      code: "auth_error",
      friendly: "API key 无效，请到 Settings 更新",
      raw,
    };
  }

  // Rate limit: transient, will succeed if we just wait. Some providers
  // return 429 for both quota and rate-limit — the quota branch above
  // catches the quota subset; the rest fall here.
  if (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("429")
  ) {
    return {
      code: "rate_limit",
      friendly: "请求过于频繁，稍后会自动重试",
      raw,
    };
  }

  // Model-not-found: wrong model ID in settings. Typical when the user
  // selects Ollama and has `qwen2.5:7b` in .env but only `llama3` pulled.
  if (
    lower.includes("model_not_found") ||
    lower.includes("model not found") ||
    lower.includes("invalid model") ||
    lower.includes("not a valid model")
  ) {
    return {
      code: "model_not_found",
      friendly: "模型未找到，检查 Settings 里的 model 名",
      raw,
    };
  }

  // Network: Ollama not running, DNS failure, connection reset.
  if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("fetch failed") ||
    lower.includes("network error") ||
    lower.includes("cli process timed out") ||
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("enotfound")
  ) {
    return {
      code: "network",
      friendly: "网络错误，稍后重试",
      raw,
    };
  }

  return { code: "unknown", friendly: raw.slice(0, 120), raw };
}

/** Encode a classification into the single TEXT column. `[code] friendly`
 *  plus a short raw tail on the same line for debugging. */
export function formatErrorMessage(c: ClassifiedLLMError): string {
  return `[${c.code}] ${c.friendly}`;
}

/** Parse the `[code]` prefix back out. Returns "unknown" when the message
 *  pre-dates this encoding (old failed rows written before the change). */
export function parseErrorCode(message: string | null): LLMErrorCode {
  if (!message) return "unknown";
  const m = message.match(/^\[([a-z_]+)\]/);
  if (!m) return "unknown";
  const code = m[1] as LLMErrorCode;
  const known: LLMErrorCode[] = [
    "quota_exhausted",
    "rate_limit",
    "auth_error",
    "model_not_found",
    "network",
    "invalid_output",
    "unknown",
  ];
  return known.includes(code) ? code : "unknown";
}
