export interface TranslationResult {
  text: string;
  tokensUsed: number;
  model: string;
}

export interface ChapterBatchItem {
  id: string;
  seq: number;
  text: string;
}

/**
 * Chapter-aware batch contract (ARCH-002): one model call carries one book,
 * one chapter, one source language, and one target language. Book/chapter
 * metadata is context for consistency only and must never appear in output.
 */
export interface ChapterBatchRequest {
  bookTitle: string;
  chapterTitle: string;
  sourceLang: string;
  targetLang: string;
  items: ChapterBatchItem[];
}

export interface TranslationBatchResult extends TranslationResult {
  id: string;
}

export interface LLMProvider {
  name: string;
  isAvailable?(): boolean;
  translate(
    text: string,
    fromLang: string,
    toLang: string,
    model?: string,
  ): Promise<TranslationResult>;
  translateBatch?(
    request: ChapterBatchRequest,
    model?: string,
  ): Promise<TranslationBatchResult[]>;
}
