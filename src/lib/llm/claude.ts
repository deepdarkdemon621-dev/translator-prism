import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, TranslationResult } from "./types";

const LANG_NAMES: Record<string, string> = {
  ja: "Japanese",
  zh: "Chinese",
  en: "English",
};

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

export class ClaudeProvider implements LLMProvider {
  name = "claude";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async translate(
    text: string,
    fromLang: string,
    toLang: string,
    model?: string,
  ): Promise<TranslationResult> {
    const useModel = model || DEFAULT_MODEL;
    const fromName = LANG_NAMES[fromLang] || fromLang;
    const toName = LANG_NAMES[toLang] || toLang;

    const response = await this.client.messages.create({
      model: useModel,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `Translate the following ${fromName} novel text into ${toName}. Maintain the literary style, tone, and nuance of the original. Return ONLY the translated text, nothing else.\n\n${text}`,
        },
      ],
    });

    const content = response.content[0];
    const translatedText = content.type === "text" ? content.text : "";
    const tokensUsed =
      (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

    return {
      text: translatedText,
      tokensUsed,
      model: useModel,
    };
  }
}
