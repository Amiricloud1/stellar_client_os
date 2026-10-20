/**
 * Typed pagination helpers for Soroban chain and indexer reads.
 *
 * Provides standardized page limits, continuation cursors, server maximums,
 * empty page handling, and repeated-cursor termination protection.
 */

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export interface PaginationOptions<TCursor = string | number | bigint> {
  /** Maximum number of records to return (1-100, defaults to 20). */
  limit?: number;
  /** Opaque cursor to start pagination from. */
  cursor?: TCursor;
}

export interface PaginatedResult<TItem, TCursor = string | number | bigint> {
  items: TItem[];
  nextCursor?: TCursor;
  hasMore: boolean;
  total?: number;
}

/**
 * Normalizes user-supplied page limits to ensure they fall within [1, MAX_PAGE_LIMIT].
 */
export function normalizePaginationLimit(limit?: number): number {
  if (limit === undefined || limit === null || isNaN(limit)) {
    return DEFAULT_PAGE_LIMIT;
  }
  const intLimit = Math.floor(limit);
  if (intLimit <= 0) return 1;
  return Math.min(intLimit, MAX_PAGE_LIMIT);
}

/**
 * In-memory pagination helper for arrays with typed cursor continuation.
 */
export function paginateArray<TItem, TCursor = string | number | bigint>(
  items: TItem[],
  options: PaginationOptions<TCursor> = {},
  getCursor: (item: TItem) => TCursor
): PaginatedResult<TItem, TCursor> {
  const limit = normalizePaginationLimit(options.limit);
  let startIndex = 0;

  if (options.cursor !== undefined) {
    const foundIndex = items.findIndex((item) => {
      const c = getCursor(item);
      return String(c) === String(options.cursor);
    });
    if (foundIndex >= 0) {
      startIndex = foundIndex + 1;
    } else {
      // Invalid cursor beyond known items returns empty page with no next cursor
      return {
        items: [],
        nextCursor: undefined,
        hasMore: false,
        total: items.length,
      };
    }
  }

  const slice = items.slice(startIndex, startIndex + limit);
  const nextItem = items[startIndex + limit];
  const nextCursor = nextItem ? getCursor(slice[slice.length - 1]) : undefined;

  return {
    items: slice,
    nextCursor,
    hasMore: nextCursor !== undefined,
    total: items.length,
  };
}

/**
 * Executes a paginated query with loop guard and boundary validation.
 */
export async function paginateQuery<TItem, TCursor = string | number | bigint>(
  fetchPage: (cursor?: TCursor, limit?: number) => Promise<PaginatedResult<TItem, TCursor>>,
  options: PaginationOptions<TCursor> = {}
): Promise<PaginatedResult<TItem, TCursor>> {
  const limit = normalizePaginationLimit(options.limit);
  const result = await fetchPage(options.cursor, limit);

  // Guard against circular/repeated cursors from providers
  if (
    result.nextCursor !== undefined &&
    options.cursor !== undefined &&
    String(result.nextCursor) === String(options.cursor)
  ) {
    return {
      ...result,
      nextCursor: undefined,
      hasMore: false,
    };
  }

  return {
    ...result,
    hasMore: Boolean(result.hasMore && result.nextCursor !== undefined),
  };
}

/**
 * Async generator that automatically walks pages until termination.
 */
export async function* iteratePages<TItem, TCursor = string | number | bigint>(
  fetchPage: (cursor?: TCursor, limit?: number) => Promise<PaginatedResult<TItem, TCursor>>,
  options: PaginationOptions<TCursor> = {}
): AsyncIterableIterator<TItem[]> {
  let currentCursor: TCursor | undefined = options.cursor;
  const limit = normalizePaginationLimit(options.limit);
  const seenCursors = new Set<string>();

  while (true) {
    if (currentCursor !== undefined) {
      const key = String(currentCursor);
      if (seenCursors.has(key)) {
        // Repeated cursor loop detected: terminate cleanly
        break;
      }
      seenCursors.add(key);
    }

    const page = await fetchPage(currentCursor, limit);
    if (!page.items || page.items.length === 0) {
      break;
    }

    yield page.items;

    if (!page.hasMore || page.nextCursor === undefined) {
      break;
    }

    currentCursor = page.nextCursor;
  }
}
