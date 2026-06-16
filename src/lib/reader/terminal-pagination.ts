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

function charWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (
    codePoint === 0 ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6))
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    width += charWidth(char);
  }
  return width;
}

export function terminalRowsForText(value: string, columns: number): number {
  const width = Math.max(1, columns);
  return value.split("\n").reduce((total, line) => {
    return total + Math.max(1, Math.ceil(displayWidth(line) / width));
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
      terminalRowsForText(options.renderItem(item), options.columns) +
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
