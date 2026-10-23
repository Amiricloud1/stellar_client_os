import { useEffect, useMemo, useRef } from "react";

export type PaginationRangeItem =
  | { type: "page"; page: number }
  | { type: "ellipsis"; key: "left" | "right" };

/**
 * Shared pagination contract for list endpoints (issue #59).
 * Mirrors the server-side `PaginationInput` so client and API stay in sync.
 */
export type PaginationInput = {
  page: number;
  pageSize: number;
};

/**
 * Shared sort contract for list endpoints (issue #59).
 * `field` is the stable sort key, `direction` the ordering.
 */
export type SortDirection = "asc" | "desc";

export type SortInput = {
  field: string;
  direction: SortDirection;
};

/**
 * Shared response metadata returned alongside paginated collections.
 */
export type PageInfo = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const clampPageSize = (pageSize?: number | null): number => {
  if (pageSize === undefined || pageSize === null || Number.isNaN(pageSize)) {
    return DEFAULT_PAGE_SIZE;
  }

  return Math.min(Math.max(1, Math.floor(pageSize)), MAX_PAGE_SIZE);
};

export const clampPage = (page?: number | null, totalPages?: number): number => {
  const safePage =
    page === undefined || page === null || Number.isNaN(page) ? DEFAULT_PAGE : Math.floor(page);
  const normalized = Math.max(DEFAULT_PAGE, safePage);

  if (totalPages === undefined || Number.isNaN(totalPages)) {
    return normalized;
  }

  return Math.min(normalized, Math.max(DEFAULT_PAGE, Math.floor(totalPages)));
};

export const normalizePaginationInput = (
  input?: Partial<PaginationInput> | null
): PaginationInput => ({
  page: clampPage(input?.page),
  pageSize: clampPageSize(input?.pageSize),
});

export const buildPageInfo = (
  input: Partial<PaginationInput> | null | undefined,
  totalItems: number
): PageInfo => {
  const { page, pageSize } = normalizePaginationInput(input);
  const safeTotal = Math.max(0, Math.floor(totalItems));
  const totalPages = Math.max(1, Math.ceil(safeTotal / pageSize));
  const clampedPage = clampPage(page, totalPages);

  return {
    page: clampedPage,
    pageSize,
    totalItems: safeTotal,
    totalPages,
    hasNextPage: clampedPage < totalPages,
    hasPreviousPage: clampedPage > 1,
  };
};

type UsePaginationParams = {
  currentPage: number;
  pageCount: number;
  siblingCount?: number;
};

const range = (start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, index) => start + index);

export const getPaginationRange = ({
  currentPage,
  pageCount,
  siblingCount = 2,
}: UsePaginationParams): PaginationRangeItem[] => {
  const safePageCount = Math.max(1, pageCount);
  const safeCurrentPage = Math.min(Math.max(1, currentPage), safePageCount);
  const windowSize = siblingCount * 2 + 1;

  if (safePageCount <= 7) {
    return range(1, safePageCount).map((page) => ({ type: "page", page }));
  }

  let left = Math.max(2, safeCurrentPage - siblingCount);
  let right = Math.min(safePageCount - 1, safeCurrentPage + siblingCount);

  while (right - left + 1 < windowSize) {
    if (left > 2) {
      left -= 1;
      continue;
    }

    if (right < safePageCount - 1) {
      right += 1;
      continue;
    }

    break;
  }

  const showLeftEllipsis = left > 2;
  const showRightEllipsis = right < safePageCount - 1;

  const items: PaginationRangeItem[] = [{ type: "page", page: 1 }];

  if (showLeftEllipsis) {
    items.push({ type: "ellipsis", key: "left" });
  }

  range(left, right).forEach((page) => {
    items.push({ type: "page", page });
  });

  if (showRightEllipsis) {
    items.push({ type: "ellipsis", key: "right" });
  }

  items.push({ type: "page", page: safePageCount });

  return items;
};

export const usePagination = ({ currentPage, pageCount, siblingCount = 2 }: UsePaginationParams) =>
  useMemo(
    () => getPaginationRange({ currentPage, pageCount, siblingCount }),
    [currentPage, pageCount, siblingCount]
  );

type UseListPaginationParams = {
  pagination?: Partial<PaginationInput> | null;
  sort?: SortInput | null;
  totalItems: number;
  siblingCount?: number;
};

export type UseListPaginationResult = {
  pagination: PaginationInput;
  pageInfo: PageInfo;
  range: PaginationRangeItem[];
};

/**
 * Combines the shared pagination/sort inputs with page metadata for list views.
 * Page size is clamped to `MAX_PAGE_SIZE` and the page is clamped to the
 * available range derived from `totalItems`.
 */
export const useListPagination = ({
  pagination,
  sort,
  totalItems,
  siblingCount = 2,
}: UseListPaginationParams): UseListPaginationResult => {
  const normalized = useMemo(() => normalizePaginationInput(pagination), [pagination]);
  const pageInfo = useMemo(
    () => buildPageInfo(normalized, totalItems),
    [normalized, totalItems]
  );

  const range = usePagination({
    currentPage: pageInfo.page,
    pageCount: pageInfo.totalPages,
    siblingCount,
  });

  return { pagination: normalized, pageInfo, range };
};

/**
 * Resets pagination to page 1 whenever the sort input changes so that
 * re-ordered collections always start from the first page (issue #59).
 */
export const useResetPageOnSortChange = (
  sort: SortInput | null | undefined,
  onReset: (page: number) => void
) => {
  const sortKey = sort ? `${sort.field}:${sort.direction}` : "";
  const previousKey = useRef(sortKey);

  useEffect(() => {
    if (previousKey.current !== sortKey) {
      previousKey.current = sortKey;
      onReset(DEFAULT_PAGE);
    }
  }, [sortKey, onReset]);
};
