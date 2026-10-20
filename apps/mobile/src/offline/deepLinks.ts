/**
 * Deep-link route parsing + offline fallback for campaign details (issue #91).
 *
 * Two supported shapes, both resolving to a campaign id:
 *   - `https://app.fundable.com/campaigns/<id>` (http(s) link)
 *   - `fundable://campaigns/<id>` (custom app scheme)
 *
 * Parsing is strict and side-effect free: malformed or non-campaign links
 * return a typed `DeepLinkError` instead of throwing, so callers (cold-start
 * routing) can fall back to the browse screen. `resolveCampaignDeepLink`
 * wires a parsed link into the read-through {@link CampaignRepository}, so a
 * cold start with no connection still opens the cached campaign, an uncached
 * campaign degrades to `unavailable`, and a later refresh (reconnect) swaps
 * the cached payload for fresh data.
 */

import {
  type CampaignCache,
  type CampaignRepository,
  formatFreshness,
} from "./campaignCache";

/** Default hosts considered "our app" for http(s) deep links. */
export const DEFAULT_DEEP_LINK_HOSTS = [
  "app.fundable.com",
  "www.fundable.com",
  "fundable.com",
] as const;

/** Path segment that identifies campaign routes (after the host). */
export const CAMPAIGN_PATH_SEGMENT = "campaigns";

/**
 * Campaign ids are opaque to routing but must be safe in a storage key and a
 * URL: 1-64 chars of `[A-Za-z0-9._-]`. Anything else is rejected as invalid.
 */
const CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export type DeepLinkError =
  | "not_a_url"
  | "unsupported_scheme"
  | "unsupported_host"
  | "not_a_campaign_route"
  | "missing_campaign_id"
  | "invalid_campaign_id";

export interface ParsedCampaignLink {
  campaignId: string;
}

export type ParseResult =
  | { ok: true; link: ParsedCampaignLink }
  | { ok: false; error: DeepLinkError };

export interface ParseOptions {
  /** Hosts accepted for http(s) links. Defaults to {@link DEFAULT_DEEP_LINK_HOSTS}. */
  hosts?: readonly string[];
  /** Custom scheme accepted (without `://`). Defaults to `fundable`. */
  scheme?: string;
}

/** Parse a deep link into a campaign route, or report why it doesn't match. */
export function parseCampaignDeepLink(
  url: string,
  options: ParseOptions = {},
): ParseResult {
  const scheme = (options.scheme ?? "fundable").toLowerCase();
  const hosts = (options.hosts ?? DEFAULT_DEEP_LINK_HOSTS).map((h) =>
    h.toLowerCase(),
  );

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "not_a_url" };
  }

  const urlScheme = parsed.protocol.replace(/:$/, "").toLowerCase();

  let segments: string[];
  if (urlScheme === "http" || urlScheme === "https") {
    if (!parsed.hostname || !hosts.includes(parsed.hostname.toLowerCase())) {
      return { ok: false, error: "unsupported_host" };
    }
    segments = splitPath(parsed.pathname);
  } else if (urlScheme === scheme) {
    // `fundable://campaigns/<id>` puts "campaigns" in `host`.
    segments = [parsed.host, ...splitPath(parsed.pathname)];
  } else {
    return { ok: false, error: "unsupported_scheme" };
  }

  const [first, id, ...rest] = segments;
  if (first !== CAMPAIGN_PATH_SEGMENT) {
    return { ok: false, error: "not_a_campaign_route" };
  }
  if (rest.length > 0) {
    return { ok: false, error: "not_a_campaign_route" };
  }
  if (!id) return { ok: false, error: "missing_campaign_id" };

  let campaignId: string;
  try {
    campaignId = decodeURIComponent(id);
  } catch {
    return { ok: false, error: "invalid_campaign_id" };
  }
  if (!CAMPAIGN_ID_PATTERN.test(campaignId)) {
    return { ok: false, error: "invalid_campaign_id" };
  }
  return { ok: true, link: { campaignId } };
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

/** Outcome of resolving a deep link against the offline-aware repository. */
export type ResolveResult<T> =
  | { status: "ok"; campaignId: string; data: T; fromCache: boolean; stale: boolean; cachedAt: number | null }
  | { status: "malformed"; error: DeepLinkError }
  /**
   * The link was well-formed but the campaign is not cached and the network
   * is unavailable (or the fetch failed). Callers should show an error /
   * "not available offline" state and retry on reconnect.
   */
  | { status: "unavailable"; campaignId: string; staleLabel: string | null };

export interface ResolveOptions<T> extends ParseOptions {
  /** Max age before a cached payload is presented as stale. */
  staleAfterMs?: number | null;
  /**
   * Optional cache handle used to report last-known freshness when the
   * campaign is unavailable (nothing cached + fetch failed).
   */
  cache?: CampaignCache<unknown, T>;
  /** Presentation helper for the unavailable state; injectable for tests. */
  formatAge?: (ageMs: number | null) => string;
}

/**
 * Resolve a deep link to campaign detail data, falling back to the cache when
 * the network fails (cold start offline). A successful network fetch
 * refreshes the cache so a later refresh serves fresh data.
 */
export async function resolveCampaignDeepLink<T>(
  url: string,
  repository: CampaignRepository<unknown, T>,
  fetchDetail: () => Promise<T>,
  options: ResolveOptions<T> = {},
): Promise<ResolveResult<T>> {
  const parsed = parseCampaignDeepLink(url, options);
  if (!parsed.ok) return { status: "malformed", error: parsed.error };

  const { campaignId } = parsed.link;
  try {
    const result = await repository.loadDetail(campaignId, fetchDetail, {
      staleAfterMs: options.staleAfterMs,
    });
    return {
      status: "ok",
      campaignId,
      data: result.data,
      fromCache: result.fromCache,
      stale: result.stale,
      cachedAt: result.cachedAt,
    };
  } catch {
    // Nothing cached and the fetch failed: surface an unavailable state with
    // the best-known freshness label (null when we have no cache at all).
    const formatAge = options.formatAge ?? formatFreshness;
    const cached = options.cache
      ? await options.cache.detailFreshness(campaignId)
      : null;
    return {
      status: "unavailable",
      campaignId,
      staleLabel: cached ? formatAge(cached.ageMs) : null,
    };
  }
}