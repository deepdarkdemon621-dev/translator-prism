import { describe, expect, it } from "vitest";
import { paginateByTerminalRows } from "@/lib/reader/terminal-pagination";

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
