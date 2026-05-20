import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANG_ORDER,
  normalizeVisibleLangs,
  orderVisibleLangs,
  toggleVisibleLang,
} from "@/lib/reader/language-selection";

describe("reader language selection", () => {
  it("defaults to every language in reader order", () => {
    expect(normalizeVisibleLangs(undefined, DEFAULT_LANG_ORDER)).toEqual([
      "ja",
      "zh",
      "en",
    ]);
  });

  it("allows hiding the source language", () => {
    expect(normalizeVisibleLangs(["zh", "en"], DEFAULT_LANG_ORDER)).toEqual([
      "zh",
      "en",
    ]);
  });

  it("orders selected languages by the persisted language order", () => {
    expect(normalizeVisibleLangs(["ja", "en"], ["en", "zh", "ja"])).toEqual([
      "en",
      "ja",
    ]);
  });

  it("pins the source language first when it is visible", () => {
    expect(orderVisibleLangs(["ja", "zh", "en"], ["ja", "zh", "en"], "zh")).toEqual([
      "zh",
      "ja",
      "en",
    ]);
    expect(orderVisibleLangs(["ja", "en"], ["ja", "zh", "en"], "zh")).toEqual([
      "ja",
      "en",
    ]);
  });

  it("deduplicates invalid stored values and falls back when none remain", () => {
    expect(normalizeVisibleLangs(["xx", "zh", "zh"], DEFAULT_LANG_ORDER)).toEqual([
      "zh",
    ]);
    expect(normalizeVisibleLangs(["xx"], DEFAULT_LANG_ORDER)).toEqual([
      "ja",
      "zh",
      "en",
    ]);
  });

  it("does not remove the last visible language", () => {
    expect(toggleVisibleLang(["zh"], "zh", DEFAULT_LANG_ORDER)).toEqual(["zh"]);
  });

  it("adds and removes languages in reader order", () => {
    expect(toggleVisibleLang(["zh", "en"], "zh", DEFAULT_LANG_ORDER)).toEqual([
      "en",
    ]);
    expect(toggleVisibleLang(["en"], "ja", DEFAULT_LANG_ORDER)).toEqual([
      "ja",
      "en",
    ]);
  });
});
