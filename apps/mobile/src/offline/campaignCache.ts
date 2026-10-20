/**
 * Persisted campaign cache + read-through repository.
 *
 * `CampaignRepository.loadList` / `loadDetail` try the network first and fall
 * back to the last cached payload when the fetch fails, so a sponsor can keep
 * browsing campaigns while offline. Successful fetches refresh the cache.
 *
 * The detail cache is bounded (issue #94): a persisted LRU index tracks every
 * cached detail and evicts the least-recently-used entries above
 * `maxDetailEntries`. Ids reported by `protectedIds` (e.g. the wishlist) are
 * never evicted. Read results carry freshness metadata (`cachedAt`, `stale`)
 * so screens can present a "last updated" state.
 */

import { type KeyValueStorage, readJSON, writeJSON } from "./storage";
import type {
  CachedValue,
  CampaignDetail,
  CampaignSummary,
} from "./types";

/** Default cap on cached campaign details (LRU-evicted above this). */
export const DEFAULT_MAX_DETAIL_ENTRIES = 50;

/** Default age after which a cached payload is presented as stale (15 min). */
export const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;

export interface CampaignCacheOptions {
  /** Storage key prefix, override to run isolated caches (e.g. per account). */
  namespace?: string;
  /** Injectable clock, defaults to `Date.now`. */
  clock?: () => number;
  /**
   * Maximum number of cached campaign details. The least-recently-used
   * entries are evicted on write once the cap is exceeded. Must be >= 1.
   */
  maxDetailEntries?: number;
  /**
   * Campaign ids that must never be evicted (e.g. the current wishlist).
   * Evaluated on every eviction pass; may be sync or async.
   */
  protectedIds?: () => readonly string[] | Promise<readonly string[]>;
  /**
   * Age after which a cache-served read is flagged `stale`. Defaults to
   * {@link DEFAULT_STALE_AFTER_MS}; pass `null` to never mark stale.
   */
  staleAfterMs?: number | null;
}

/** One entry of the persisted LRU index over cached campaign details. */
interface DetailIndexEntry {
  id: string;
  cachedAt: number;
  lastAccessedAt: number;
}

/** Persisted LRU index. `version` makes future migrations explicit. */
interface PersistedDetailIndex {
  version: 1;
  entries: DetailIndexEntry[];
}

export class CampaignCache<
  TList = CampaignSummary[],
  TDetail = CampaignDetail,
> {
  private readonly namespace: string;
  private readonly clock: () => number;
  private readonly maxDetailEntries: number;
  private readonly protectedIds?: () =>
    | readonly string[]
    | Promise<readonly string[]>;
  private readonly staleAfterMs: number | null;

  constructor(
    private readonly storage: KeyValueStorage,
    options: CampaignCacheOptions = {},
  ) {
    this.namespace = options.namespace ?? "fundable.offline.cache";
    this.clock = options.clock ?? Date.now;
    const max = options.maxDetailEntries ?? DEFAULT_MAX_DETAIL_ENTRIES;
    this.maxDetailEntries = Math.max(1, Math.floor(max));
    this.protectedIds = options.protectedIds;
    this.staleAfterMs =
      options.staleAfterMs === undefined
        ? DEFAULT_STALE_AFTER_MS
        : options.staleAfterMs;
  }

  /** Current time via the injected clock (also used by the repository). */
  now(): number {
    return this.clock();
  }

  /** Storage key for the cached campaign list. */
  listKey(): string {
    return `${this.namespace}.campaigns.list`;
  }

  /** Storage key for a cached campaign detail. */
  detailKey(campaignId: string): string {
    return `${this.namespace}.campaigns.detail.${campaignId}`;
  }

  /** Storage key for the persisted detail LRU index. */
  private detailIndexKey(): string {
    return `${this.namespace}.campaigns.detailIndex`;
  }

  async saveList(campaigns: TList): Promise<void> {
    await writeJSON<CachedValue<TList>>(this.storage, this.listKey(), {
      data: campaigns,
      cachedAt: this.clock(),
    });
  }

  async readList(): Promise<CachedValue<TList> | null> {
    return readJSON<CachedValue<TList>>(this.storage, this.listKey());
  }

  async saveDetail(campaignId: string, detail: TDetail): Promise<void> {
    const now = this.clock();
    await writeJSON<CachedValue<TDetail>>(
      this.storage,
      this.detailKey(campaignId),
      { data: detail, cachedAt: now },
    );
    const index = await this.loadDetailIndex();
    const existing = index.entries.find((entry) => entry.id === campaignId);
    if (existing) {
      existing.cachedAt = now;
      existing.lastAccessedAt = now;
    } else {
      index.entries.push({ id: campaignId, cachedAt: now, lastAccessedAt: now });
    }
    await this.enforceDetailLimit(index);
  }

  async readDetail(campaignId: string): Promise<CachedValue<TDetail> | null> {
    const value = await readJSON<CachedValue<TDetail>>(
      this.storage,
      this.detailKey(campaignId),
    );
    if (value === null) return null;
    // Touch the LRU index so frequently-read campaigns are evicted last.
    const index = await this.loadDetailIndex();
    const entry = index.entries.find((e) => e.id === campaignId);
    if (entry) {
      entry.lastAccessedAt = this.clock();
    } else {
      index.entries.push({
        id: campaignId,
        cachedAt: value.cachedAt,
        lastAccessedAt: this.clock(),
      });
    }
    await writeJSON<PersistedDetailIndex>(
      this.storage,
      this.detailIndexKey(),
      index,
    );
    return value;
  }

  /**
   * Freshness metadata for a cached detail without touching the LRU order.
   * Returns `null` when nothing is cached.
   */
  async detailFreshness(
    campaignId: string,
  ): Promise<{ cachedAt: number; ageMs: number; stale: boolean } | null> {
    const value = await readJSON<CachedValue<TDetail>>(
      this.storage,
      this.detailKey(campaignId),
    );
    if (value === null) return null;
    const ageMs = Math.max(0, this.clock() - value.cachedAt);
    return { cachedAt: value.cachedAt, ageMs, stale: this.isStale(ageMs) };
  }

  /** Whether a payload of the given age should be presented as stale. */
  isStale(ageMs: number): boolean {
    return this.staleAfterMs !== null && ageMs > this.staleAfterMs;
  }

  /** Number of campaign details currently tracked by the LRU index. */
  async detailCount(): Promise<number> {
    return (await this.loadDetailIndex()).entries.length;
  }

  /**
   * Load the detail LRU index, migrating pre-existing caches on first use.
   *
   * Caches written before this index existed have detail entries but no index
   * rows. When the storage backend supports `getAllKeys`, those entries are
   * discovered and indexed with `lastAccessedAt = cachedAt`, so they join
   * eviction like newer entries. On backends without `getAllKeys` the index
   * starts empty: legacy entries stay readable but are not evicted until
   * rewritten.
   */
  private async loadDetailIndex(): Promise<PersistedDetailIndex> {
    const existing = await readJSON<PersistedDetailIndex>(
      this.storage,
      this.detailIndexKey(),
    );
    if (existing && Array.isArray(existing.entries)) return existing;

    const entries: DetailIndexEntry[] = [];
    if (this.storage.getAllKeys) {
      const prefix = `${this.namespace}.campaigns.detail.`;
      const keys = await this.storage.getAllKeys();
      for (const key of keys) {
        if (!key.startsWith(prefix)) continue;
        const value = await readJSON<CachedValue<TDetail>>(this.storage, key);
        if (value === null) continue;
        entries.push({
          id: key.slice(prefix.length),
          cachedAt: value.cachedAt,
          lastAccessedAt: value.cachedAt,
        });
      }
    }
    return { version: 1, entries };
  }

  /** Evict LRU detail entries above the cap, never touching protected ids. */
  private async enforceDetailLimit(index: PersistedDetailIndex): Promise<void> {
    if (index.entries.length <= this.maxDetailEntries) {
      await writeJSON<PersistedDetailIndex>(
        this.storage,
        this.detailIndexKey(),
        index,
      );
      return;
    }
    const protectedSet = new Set(
      this.protectedIds ? await this.protectedIds() : [],
    );
    // Victim order: least recently accessed first, ties broken deterministically.
    const ordered = [...index.entries].sort(
      (a, b) =>
        a.lastAccessedAt - b.lastAccessedAt ||
        a.cachedAt - b.cachedAt ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const excess = index.entries.length - this.maxDetailEntries;
    const evicted: string[] = [];
    for (const entry of ordered) {
      if (evicted.length >= excess) break;
      if (protectedSet.has(entry.id)) continue;
      evicted.push(entry.id);
    }
    await Promise.all(
      evicted.map((id) => this.storage.removeItem(this.detailKey(id))),
    );
    const evictedSet = new Set(evicted);
    index.entries = index.entries.filter((entry) => !evictedSet.has(entry.id));
    await writeJSON<PersistedDetailIndex>(
      this.storage,
      this.detailIndexKey(),
      index,
    );
  }


  /** Remove every cache entry owned by this namespace. */
  async clear(): Promise<void> {
    if (!this.storage.getAllKeys) return;
    const prefix = `${this.namespace}.campaigns.`;
    const keys = await this.storage.getAllKeys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(prefix))
        .map((key) => this.storage.removeItem(key)),
    );
  }
}

/**
 * Human-readable "last updated" label for stale-state presentation. Pure in
 * `ageMs`, so it is deterministic in tests.
 */
export function formatFreshness(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return "updated just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "updated just now";
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}

/** Result of a read-through load, indicating whether it came from cache. */
export interface ReadResult<T> {
  data: T;
  fromCache: boolean;
  cachedAt: number | null;
  /**
   * True when the payload was served from cache and its age exceeds the
   * stale threshold (issue #94). Network reads and cache fallbacks with no
   * timestamp are never marked stale.
   */
  stale: boolean;
}

export type Fetcher<T> = () => Promise<T>;

export interface LoadOptions<T> {
  /**
   * Value returned when the network fails and nothing is cached. When omitted,
   * the original network error is re-thrown (useful for detail screens that
   * must show an error state).
   */
  fallback?: T;
  /** Per-load override for the stale threshold (see `CampaignCacheOptions`). */
  staleAfterMs?: number | null;
}

export class CampaignRepository<
  TList = CampaignSummary[],
  TDetail = CampaignDetail,
> {
  constructor(private readonly cache: CampaignCache<TList, TDetail>) {}

  /**
   * Network-first read of the campaign list. On failure, serve the cached list
   * (offline browse). When nothing is cached and no `fallback` is given, the
   * original error propagates.
   */
  async loadList(
    fetchList: Fetcher<TList>,
    options: LoadOptions<TList> = {},
  ): Promise<ReadResult<TList>> {
    try {
      const fresh = await fetchList();
      await this.cache.saveList(fresh);
      return {
        data: fresh,
        fromCache: false,
        cachedAt: null,
        stale: false,
      };
    } catch (error) {
      const cached = await this.cache.readList();
      if (cached) {
        return {
          data: cached.data,
          fromCache: true,
          cachedAt: cached.cachedAt,
          stale: this.staleFor(cached.cachedAt, options),
        };
      }
      if (Object.prototype.hasOwnProperty.call(options, "fallback")) {
        return {
          data: options.fallback as TList,
          fromCache: true,
          cachedAt: null,
          stale: false,
        };
      }
      throw error;
    }
  }

  /** Network-first read of a campaign detail with the same offline fallback. */
  async loadDetail(
    campaignId: string,
    fetchDetail: Fetcher<TDetail>,
    options: LoadOptions<TDetail> = {},
  ): Promise<ReadResult<TDetail>> {
    try {
      const fresh = await fetchDetail();
      await this.cache.saveDetail(campaignId, fresh);
      return {
        data: fresh,
        fromCache: false,
        cachedAt: null,
        stale: false,
      };
    } catch (error) {
      const cached = await this.cache.readDetail(campaignId);
      if (cached) {
        return {
          data: cached.data,
          fromCache: true,
          cachedAt: cached.cachedAt,
          stale: this.staleFor(cached.cachedAt, options),
        };
      }
      if (Object.prototype.hasOwnProperty.call(options, "fallback")) {
        return {
          data: options.fallback as TDetail,
          fromCache: true,
          cachedAt: null,
          stale: false,
        };
      }
      throw error;
    }
  }

  /** Compute the `stale` flag for a cache-served read (issue #94). */
  private staleFor(cachedAt: number, options: LoadOptions<unknown>): boolean {
    const ageMs = Math.max(0, this.cache.now() - cachedAt);
    if (options.staleAfterMs !== undefined) {
      return (
        options.staleAfterMs !== null && ageMs > options.staleAfterMs
      );
    }
    return this.cache.isStale(ageMs);
  }
}
