export type TerminalPaginationOptions<T> = {
  renderItem: (item: T) => string;
  rows: number | undefined;
  columns: number | undefined;
  reservedRows: number;
  separatorRows: number;
  fallbackPageSize: number;
};

export type TerminalPaginationResult<T> = {
  page: number;
  pageCount: number;
  items: T[];
};

function fixedPage<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
): TerminalPaginationResult<T> {
  const safePageSize = Math.max(1, pageSize);
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize));
  const safePage = Math.min(Math.max(0, Math.trunc(page)), pageCount - 1);
  const start = safePage * safePageSize;
  return {
    page: safePage,
    pageCount,
    items: items.slice(start, start + safePageSize),
  };
}

function visualRows(value: string, columns: number): number {
  const width = Math.max(1, columns);
  return value.split("\n").reduce((total, line) => {
    return total + Math.max(1, Math.ceil(line.length / width));
  }, 0);
}

export function paginateByTerminalRows<T>(
  items: readonly T[],
  page: number,
  options: TerminalPaginationOptions<T>,
): TerminalPaginationResult<T> {
  if (!options.rows || !options.columns) {
    return fixedPage(items, page, options.fallbackPageSize);
  }

  const availableRows = Math.max(1, options.rows - options.reservedRows);
  const pages: T[][] = [];
  let currentPage: T[] = [];
  let currentRows = 0;

  for (const item of items) {
    const itemRows =
      visualRows(options.renderItem(item), options.columns) +
      options.separatorRows;
    if (currentPage.length > 0 && currentRows + itemRows > availableRows) {
      pages.push(currentPage);
      currentPage = [];
      currentRows = 0;
    }

    currentPage.push(item);
    currentRows += itemRows;
  }

  if (currentPage.length > 0) pages.push(currentPage);
  if (pages.length === 0) pages.push([]);

  const safePage = Math.min(Math.max(0, Math.trunc(page)), pages.length - 1);
  return {
    page: safePage,
    pageCount: pages.length,
    items: pages[safePage],
  };
}
