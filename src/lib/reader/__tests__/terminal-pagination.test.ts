import { describe, expect, it } from "vitest";
import {
  paginateByTerminalRows,
  terminalRowsForText,
} from "@/lib/reader/terminal-pagination";

describe("terminal row-aware pagination", () => {
  it("keeps a rendered page within the available terminal rows", () => {
    const result = paginateByTerminalRows(["one", "two", "three"], 0, {
      renderItem: (value) => `[1]\n${value}`,
      rows: 10,
      columns: 20,
      reservedRows: 4,
      separatorRows: 1,
      fallbackPageSize: 8,
    });

    expect(result.page).toBe(0);
    expect(result.pageCount).toBe(2);
    expect(result.items).toEqual(["one", "two"]);
  });

  it("counts CJK full-width characters as two terminal columns", () => {
    expect(terminalRowsForText("中文中文中文", 6)).toBe(2);
  });

  it("uses wrapped header and footer rows when reserving viewport space", () => {
    const headerRows = terminalRowsForText(
      [
        "Prism Local EPUB Reader",
        "Book: 很长很长很长的中文书名",
        "File: C:\\Programming\\translator\\test-novel\\gzr.epub",
        "",
        "n next | p prev | ] next chapter | [ prev chapter | t toc | q quit",
      ].join("\n"),
      16,
    );

    const result = paginateByTerminalRows(["短句", "第二句"], 0, {
      renderItem: (value) => `ZH  ${value}`,
      rows: 12,
      columns: 16,
      reservedRows: headerRows,
      separatorRows: 1,
      fallbackPageSize: 8,
    });

    expect(result.pageCount).toBe(2);
    expect(result.items).toEqual(["短句"]);
  });

  it("includes at least one item even when one block is taller than the viewport", () => {
    const longBlock = Array.from({ length: 20 }, (_, index) => `line ${index}`)
      .join("\n");

    const result = paginateByTerminalRows([longBlock, "next"], 0, {
      renderItem: (value) => value,
      rows: 8,
      columns: 20,
      reservedRows: 4,
      separatorRows: 1,
      fallbackPageSize: 8,
    });

    expect(result.pageCount).toBe(2);
    expect(result.items).toEqual([longBlock]);
  });

  it("falls back to fixed item pagination when terminal dimensions are unknown", () => {
    const result = paginateByTerminalRows(["a", "b", "c"], 1, {
      renderItem: (value) => value,
      rows: undefined,
      columns: undefined,
      reservedRows: 4,
      separatorRows: 1,
      fallbackPageSize: 2,
    });

    expect(result.page).toBe(1);
    expect(result.pageCount).toBe(2);
    expect(result.items).toEqual(["c"]);
  });
});
