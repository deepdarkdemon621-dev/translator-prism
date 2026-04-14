import OpenAI from "openai";
import type { LLMProvider, TranslationResult } from "./types";

const LANG_NAMES: Record<string, string> = {
  ja: "Japanese",
  zh: "Chinese",
  en: "English",
};

export class OpenAIProvider implements LLMProvider {
  name: string;
  private client: OpenAI;
  private defaultModel: string;

  constructor(
    apiKey: string,
    options: { baseURL?: string; name?: string; defaultModel?: string } = {},
  ) {
    this.name = options.name ?? "openai";
    this.defaultModel = options.defaultModel ?? "gpt-4o-mini";
    this.client = new OpenAI({
      apiKey,
      baseURL: options.baseURL,
    });
  }

  async translate(
    text: string,
    fromLang: string,
    toLang: string,
    model?: string,
  ): Promise<TranslationResult> {
    const useModel = model || this.defaultModel;
    const fromName = LANG_NAMES[fromLang] || fromLang;
    const toName = LANG_NAMES[toLang] || toLang;

    const response = await this.client.chat.completions.create({
      model: useModel,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `Translate the following ${fromName} novel text into ${toName}. Maintain the literary style, tone, and nuance of the original. Return ONLY the translated text, nothing else.\n\n${text}`,
        },
      ],
    });

    const translatedText = response.choices[0]?.message?.content ?? "";
    const tokensUsed =
      (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0);

    return {
      text: translatedText,
      tokensUsed,
      model: useModel,
    };
  }
}
