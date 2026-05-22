import { describe, expect, it } from "vitest";
import {
  filterProgressBooks,
  getAdjacentProgressPage,
  getDefaultProgressFilter,
  paginateProgressBooks,
  type ProgressBookSummary,
} from "@/lib/progress-view";

function book(
  id: string,
  overrides: Partial<ProgressBookSummary> = {},
): ProgressBookSummary {
  return {
    id,
    title: id,
    pending: 0,
    processing: 0,
    failed: 0,
    done: 0,
    total: 10,
    doneChapters: 0,
    totalChapters: 1,
    hasCover: false,
    ...overrides,
  };
}

describe("progress-view helpers", () => {
  it("defaults to active when any book has pending, processing, or failed work", () => {
    expect(getDefaultProgressFilter([book("done"), book("active", { pending: 1 })])).toBe("active");
  });

  it("defaults to all when no book needs attention", () => {
    expect(getDefaultProgressFilter([book("done", { done: 10 })])).toBe("all");
  });

  it("filters active books to failed, processing, or pending work", () => {
    const books = [
      book("done", { done: 10 }),
      book("pending", { pending: 1 }),
      book("processing", { processing: 1 }),
      book("failed", { failed: 1 }),
    ];

    expect(filterProgressBooks(books, "active").map((b) => b.id)).toEqual([
      "pending",
      "processing",
      "failed",
    ]);
  });

  it("filters failed books only", () => {
    const books = [book("pending", { pending: 1 }), book("failed", { failed: 1 })];
    expect(filterProgressBooks(books, "failed").map((b) => b.id)).toEqual(["failed"]);
  });

  it("paginates progress books and clamps out-of-range pages", () => {
    const books = Array.from({ length: 25 }, (_, i) => book(`book-${i + 1}`));

    const pageTwo = paginateProgressBooks(books, 2, 10);
    expect(pageTwo.items.map((b) => b.id)).toEqual([
      "book-11",
      "book-12",
      "book-13",
      "book-14",
      "book-15",
      "book-16",
      "book-17",
      "book-18",
      "book-19",
      "book-20",
    ]);
    expect(pageTwo.totalPages).toBe(3);

    const clamped = paginateProgressBooks(books, 99, 10);
    expect(clamped.page).toBe(3);
    expect(clamped.items.map((b) => b.id)).toEqual([
      "book-21",
      "book-22",
      "book-23",
      "book-24",
      "book-25",
    ]);
  });

  it("calculates adjacent pages from the displayed clamped page", () => {
    const books = Array.from({ length: 25 }, (_, i) => book(`book-${i + 1}`));
    const clamped = paginateProgressBooks(books, 99, 10);

    expect(clamped.page).toBe(3);
    expect(getAdjacentProgressPage(clamped.page, clamped.totalPages, -1)).toBe(2);
    expect(getAdjacentProgressPage(clamped.page, clamped.totalPages, 1)).toBe(3);
  });
});
