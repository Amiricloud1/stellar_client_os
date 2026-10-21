export enum StreamStatus {
  Active = 'Active',
  Paused = 'Paused',
  Canceled = 'Canceled',
  Completed = 'Completed',
}

export interface Stream {
  id: number; // u64 in rust, usually safe as number in JS unless very large, then bigint/string
  sender: string; // Address
  recipient: string; // Address
  token: string; // Address
  total_amount: bigint; // i128
  withdrawn_amount: bigint; // i128
  start_time: number; // u64
  end_time: number; // u64
  status: StreamStatus;
  delegateAddress?: string | null; // Delegate address for withdrawal rights
}

export enum CampaignStatus {
  Draft = 'Draft',
  Active = 'Active',
  Completed = 'Completed',
  Canceled = 'Canceled',
}

export interface Campaign {
  id: number;
  creator: string; // Address
  species: string;
  goal_amount: bigint;
  raised_amount: bigint;
  start_time: number;
  end_time: number;
  status: CampaignStatus;
}

export interface CloneCampaignInput {
  sourceCampaignId: number;
}

// ---------------------------------------------------------------------------
// Issue #59: Shared pagination & sorting contract
//
// This module is the single source of truth for list endpoints (campaigns,
// backers, audit, analytics). All list services, GraphQL resolvers, and hooks
// MUST consume these types and helpers so ordering, page limits, and response
// metadata stay consistent.
// ---------------------------------------------------------------------------

/** Maximum number of items a single page may return. */
export const MAX_PAGE_SIZE = 100;

/** Default page size when the caller does not specify one. */
export const DEFAULT_PAGE_SIZE = 20;

/** Sort direction shared by all list endpoints. */
export type SortDirection = 'asc' | 'desc';

/**
 * Pagination input accepted by list endpoints.
 *
 * - `page` is 1-based. Values below 1 are normalized to 1.
 * - `pageSize` is clamped to `[1, MAX_PAGE_SIZE]`.
 */
export interface PaginationInput {
  page?: number;
  pageSize?: number;
}

/** Normalized pagination values after applying defaults and limits. */
export interface NormalizedPagination {
  page: number;
  pageSize: number;
  /** Number of items to skip (0-based offset). */
  offset: number;
}

/**
 * Sorting input accepted by list endpoints.
 *
 * `field` must be present in the endpoint's allowlist; unknown fields fall
 * back to the endpoint's default sort field.
 */
export interface SortInput {
  field?: string;
  direction?: SortDirection;
}

/** Normalized sorting values after allowlist validation. */
export interface NormalizedSort {
  field: string;
  direction: SortDirection;
}

/**
 * Shared response metadata attached to every paginated list response.
 */
export interface PageInfo {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  sortField: string;
  sortDirection: SortDirection;
}

/**
 * Generic paginated response envelope used by all list endpoints.
 */
export interface PaginatedResponse<T> {
  items: T[];
  pageInfo: PageInfo;
}

/**
 * Normalize pagination input, applying defaults and clamping to limits.
 *
 * Boundary behavior:
 * - `page` < 1 or non-finite -> 1
 * - `pageSize` < 1 or non-finite -> `DEFAULT_PAGE_SIZE`
 * - `pageSize` > `MAX_PAGE_SIZE` -> `MAX_PAGE_SIZE`
 */
export function normalizePagination(
  input: PaginationInput = {},
): NormalizedPagination {
  const rawPage = input.page;
  const page =
    typeof rawPage === 'number' && Number.isFinite(rawPage) && rawPage >= 1
      ? Math.floor(rawPage)
      : 1;

  const rawPageSize = input.pageSize;
  let pageSize: number;
  if (
    typeof rawPageSize === 'number' &&
    Number.isFinite(rawPageSize) &&
    rawPageSize >= 1
  ) {
    pageSize = Math.floor(rawPageSize);
  } else {
    pageSize = DEFAULT_PAGE_SIZE;
  }
  if (pageSize > MAX_PAGE_SIZE) {
    pageSize = MAX_PAGE_SIZE;
  }

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

/**
 * Validate a requested sort field against an allowlist.
 *
 * Returns the requested field when allowed, otherwise the provided default.
 * Direction defaults to `'desc'` when not supplied or invalid.
 */
export function normalizeSort(
  input: SortInput = {},
  allowedFields: readonly string[],
  defaultField: string,
  defaultDirection: SortDirection = 'desc',
): NormalizedSort {
  const requested = input.field;
  const field =
    typeof requested === 'string' && allowedFields.includes(requested)
      ? requested
      : defaultField;

  const direction: SortDirection =
    input.direction === 'asc' || input.direction === 'desc'
      ? input.direction
      : defaultDirection;

  return { field, direction };
}

/**
 * Stable tie-breaker fields appended to every sort so pagination is
 * deterministic when primary sort values are equal.
 *
 * Ordering is applied in the sequence returned: primary field first, then
 * `createdAt` (when present), then `id` as the final deterministic key.
 */
export function buildStableTieBreaker(
  primaryField: string,
  direction: SortDirection,
  options: { hasCreatedAt?: boolean } = {},
): Array<{ field: string; direction: SortDirection }> {
  const keys: Array<{ field: string; direction: SortDirection }> = [
    { field: primaryField, direction },
  ];

  if (options.hasCreatedAt && primaryField !== 'createdAt') {
    keys.push({ field: 'createdAt', direction });
  }

  if (primaryField !== 'id') {
    keys.push({ field: 'id', direction });
  }

  return keys;
}

/**
 * Build the shared `PageInfo` metadata for a paginated response.
 */
export function buildPageInfo(
  pagination: NormalizedPagination,
  sort: NormalizedSort,
  totalItems: number,
): PageInfo {
  const safeTotal = Number.isFinite(totalItems) && totalItems > 0 ? totalItems : 0;
  const totalPages = safeTotal === 0 ? 0 : Math.ceil(safeTotal / pagination.pageSize);

  return {
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalItems: safeTotal,
    totalPages,
    hasNextPage: pagination.page < totalPages,
    hasPreviousPage: pagination.page > 1 && totalPages > 0,
    sortField: sort.field,
    sortDirection: sort.direction,
  };
}

export * from './campaign-voting';
export * from './onchain-tracking';
export * from './creator-revenue-share';
export * from './fraud-detection';
export * from './impact-nft';