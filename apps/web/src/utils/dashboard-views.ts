/**
 * Dashboard View & Safe URL State Utilities (#251).
 *
 * Preserves supported public filters (category, status, dateRange, search query)
 * in URL search parameters while stripping account-scoped or sensitive tokens
 * (credentials, session tokens, private keys, wallet secrets).
 */

export interface DashboardFilterState {
  category?: string;
  status?: string;
  query?: string;
  sort?: string;
  page?: number;
}

const SENSITIVE_PARAM_KEYS = new Set([
  'account',
  'wallet',
  'address',
  'secret',
  'key',
  'privateKey',
  'token',
  'auth',
  'session',
  'credential',
]);

const ALLOWED_PUBLIC_KEYS = new Set(['category', 'status', 'q', 'sort', 'page', 'timeRange']);

/**
 * Strips account-scoped and sensitive parameters, returning a sanitized URLSearchParams.
 */
export function sanitizeDashboardSearchParams(
  params: URLSearchParams | Record<string, string | undefined>
): URLSearchParams {
  const source = params instanceof URLSearchParams ? params : new URLSearchParams();
  if (!(params instanceof URLSearchParams)) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) source.set(k, v);
    }
  }

  const clean = new URLSearchParams();
  for (const [k, v] of source.entries()) {
    const lowerKey = k.toLowerCase();
    if (!SENSITIVE_PARAM_KEYS.has(lowerKey) && ALLOWED_PUBLIC_KEYS.has(k)) {
      clean.set(k, v);
    }
  }
  return clean;
}

/**
 * Encodes dashboard filter state into safe query string parameters.
 */
export function encodeDashboardFilters(filters: DashboardFilterState): string {
  const params = new URLSearchParams();
  if (filters.category) params.set('category', filters.category);
  if (filters.status) params.set('status', filters.status);
  if (filters.query) params.set('q', filters.query);
  if (filters.sort) params.set('sort', filters.sort);
  if (filters.page && filters.page > 1) params.set('page', String(filters.page));
  return params.toString();
}

/**
 * Restores dashboard filter state from URL search params.
 */
export function parseDashboardFilters(params: URLSearchParams): DashboardFilterState {
  const safe = sanitizeDashboardSearchParams(params);
  return {
    category: safe.get('category') ?? undefined,
    status: safe.get('status') ?? undefined,
    query: safe.get('q') ?? undefined,
    sort: safe.get('sort') ?? undefined,
    page: safe.get('page') ? Number(safe.get('page')) : undefined,
  };
}
