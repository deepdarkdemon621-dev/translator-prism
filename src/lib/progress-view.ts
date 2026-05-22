export type ProgressFilter = "active" | "failed" | "all";

export interface ProgressBookSummary {
  id: string;
  title: string;
  hasCover: boolean;
  done: number;
  pending: number;
  processing: number;
  failed: number;
  total: number;
  doneChapters: number;
  totalChapters: number;
}

function isActive(book: ProgressBookSummary): boolean {
  return book.pending > 0 || book.processing > 0 || book.failed > 0;
}

export function getDefaultProgressFilter(
  books: ProgressBookSummary[],
): ProgressFilter {
  return books.some(isActive) ? "active" : "all";
}

export function filterProgressBooks(
  books: ProgressBookSummary[],
  filter: ProgressFilter,
): ProgressBookSummary[] {
  if (filter === "all") return books;
  if (filter === "failed") return books.filter((book) => book.failed > 0);
  return books.filter(isActive);
}

export function paginateProgressBooks<T>(
  items: T[],
  requestedPage: number,
  pageSize: number,
): { items: T[]; page: number; totalPages: number; start: number; end: number } {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const totalPages = Math.max(1, Math.ceil(items.length / safePageSize));
  const page = Math.min(
    totalPages,
    Math.max(1, Math.floor(Number.isFinite(requestedPage) ? requestedPage : 1)),
  );
  const startIndex = (page - 1) * safePageSize;
  const pageItems = items.slice(startIndex, startIndex + safePageSize);

  return {
    items: pageItems,
    page,
    totalPages,
    start: items.length === 0 ? 0 : startIndex + 1,
    end: startIndex + pageItems.length,
  };
}

export function getAdjacentProgressPage(
  currentDisplayedPage: number,
  totalPages: number,
  direction: -1 | 1,
): number {
  return Math.min(totalPages, Math.max(1, currentDisplayedPage + direction));
}
