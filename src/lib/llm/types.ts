export interface TranslationResult {
  text: string;
  tokensUsed: number;
  model: string;
}

export interface LLMProvider {
  name: string;
  translate(
    text: string,
    fromLang: string,
    toLang: string,
    model?: string,
  ): Promise<TranslationResult>;
}
