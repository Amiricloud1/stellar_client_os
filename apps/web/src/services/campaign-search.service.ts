import type { CampaignDataSource, CampaignRecord } from "./campaign.service";

export interface CampaignSearchQuery {
  query: string;
  location?: string;
  species?: string;
  creator?: string;
  limit?: number;
  offset?: number;
}

export interface CampaignSearchResult {
  campaign: CampaignRecord;
  score: number;
  highlights: string[];
}

export interface CampaignSearchProvider {
  search(query: CampaignSearchQuery): Promise<CampaignSearchResult[]>;
  searchBatch?(ids: string[], options?: CampaignBatchOptions): Promise<CampaignBatchResult>;
}

/** Hard cap on ids per discovery batch read; larger requests are rejected. */
export const MAX_DISCOVERY_BATCH_SIZE = 50;

export interface CampaignBatchOptions {
  /** Caller identity used for authorization; unauthorized ids surface as errors. */
  viewerId?: string;
  /** Optional predicate to authorize a campaign for the viewer. */
  canView?: (campaign: CampaignRecord, viewerId?: string) => boolean;
}

export type CampaignBatchErrorCode = "not_found" | "forbidden" | "invalid_id";

export interface CampaignBatchError {
  id: string;
  code: CampaignBatchErrorCode;
  message: string;
}

export interface CampaignBatchResult {
  items: CampaignRecord[];
  errors: CampaignBatchError[];
}

/** Raised when a batch request exceeds MAX_DISCOVERY_BATCH_SIZE. */
export class CampaignBatchSizeError extends Error {
  constructor(public readonly requested: number, public readonly max: number = MAX_DISCOVERY_BATCH_SIZE) {
    super(`Campaign batch read rejected: requested ${requested} ids, maximum is ${max}`);
    this.name = "CampaignBatchSizeError";
  }
}

/** Normalize ids: trim, drop empties, de-duplicate while preserving order. */
function normalizeBatchIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * Resolve a bounded set of campaigns in a single set-based read.
 *
 * Partial-error semantics (stable envelope):
 * - `items` contains only campaigns that exist and are authorized, in the
 *   order of the de-duplicated input ids.
 * - `errors` contains one entry per requested id that could not be returned,
 *   with a stable `code`: `not_found` (no such campaign), `forbidden`
 *   (exists but the viewer may not see it), or `invalid_id` (blank id).
 * - Missing and unauthorized ids are never distinguished by omission alone;
 *   callers must inspect `errors` to render recovery UI.
 * - Oversized batches throw `CampaignBatchSizeError` before any read occurs;
 *   callers should split the request into chunks of MAX_DISCOVERY_BATCH_SIZE.
 */
export async function readCampaignBatch(
  source: CampaignDataSource,
  ids: string[],
  options: CampaignBatchOptions = {},
): Promise<CampaignBatchResult> {
  const normalized = normalizeBatchIds(ids);
  if (normalized.length > MAX_DISCOVERY_BATCH_SIZE) {
    throw new CampaignBatchSizeError(normalized.length);
  }
  const errors: CampaignBatchError[] = [];
  const requested = ids.filter((id) => typeof id !== "string" || !id.trim());
  for (const id of requested) {
    errors.push({ id, code: "invalid_id", message: "Campaign id is empty" });
  }
  if (normalized.length === 0) return { items: [], errors };

  // Single set-based fetch: no per-id round trips (no N+1).
  const campaigns = await source.getCampaigns();
  const byId = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const items: CampaignRecord[] = [];
  for (const id of normalized) {
    const campaign = byId.get(id);
    if (!campaign) {
      errors.push({ id, code: "not_found", message: `Campaign ${id} was not found` });
      continue;
    }
    if (options.canView && !options.canView(campaign, options.viewerId)) {
      errors.push({ id, code: "forbidden", message: `Campaign ${id} is not accessible` });
      continue;
    }
    items.push(campaign);
  }
  return { items, errors };
}

function tokens(value: string | undefined): string[] {
  return (value ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Search tags plus the single impact-reporting species and tree species labels. */
function speciesValues(campaign: CampaignRecord): string[] {
  return [...(campaign.speciesTags ?? []), campaign.species, campaign.treeSpecies].filter(
    (value): value is string => Boolean(value),
  );
}

function documentTokens(campaign: CampaignRecord): string[] {
  return tokens([
    campaign.name,
    campaign.description,
    campaign.location,
    campaign.creator,
    ...speciesValues(campaign),
  ].join(" "));
}

/**
 * Search adapter used in development and tests. Its scoring/tokenization
 * mirrors the Elasticsearch integration contract, so production can swap in
 * an Elasticsearch provider without changing the API or UI.
 */
export class InMemoryCampaignSearchProvider implements CampaignSearchProvider {
  constructor(private readonly source: CampaignDataSource) {}

  async search(query: CampaignSearchQuery): Promise<CampaignSearchResult[]> {
    const requested = tokens(query.query);
    const location = query.location?.trim().toLowerCase();
    const species = query.species?.trim().toLowerCase();
    const creator = query.creator?.trim().toLowerCase();
    const campaigns = await this.source.getCampaigns();

    return campaigns
      .filter((campaign) => {
        if (location && !(campaign.location ?? "").toLowerCase().includes(location)) return false;
        if (species && !speciesValues(campaign).some((item) => item.toLowerCase().includes(species))) return false;
        if (creator && !campaign.creator.toLowerCase().includes(creator)) return false;
        const words = documentTokens(campaign);
        return requested.every((term) => words.some((word) => word.includes(term)));
      })
      .map((campaign) => {
        const text = documentTokens(campaign).join(" ");
        const matched = requested.filter((term) => text.includes(term));
        const highlights = [campaign.name, campaign.location, ...speciesValues(campaign)].filter((value): value is string => Boolean(value)).filter((value) =>
          requested.some((term) => value.toLowerCase().includes(term)),
        );
        return { campaign, score: matched.length / Math.max(requested.length, 1), highlights };
      })
      .sort((a, b) => b.score - a.score || b.campaign.updatedAt - a.campaign.updatedAt)
      .slice(Math.max(query.offset ?? 0, 0), Math.max(query.offset ?? 0, 0) + Math.min(Math.max(query.limit ?? 20, 1), 100));
  }
}

/** Elasticsearch-compatible HTTP adapter for deployments with an index. */
export class ElasticsearchCampaignSearchProvider implements CampaignSearchProvider {
  constructor(private readonly endpoint: string, private readonly fetcher: typeof fetch = fetch) {}

  async search(query: CampaignSearchQuery): Promise<CampaignSearchResult[]> {
    const response = await this.fetcher(`${this.endpoint.replace(/\/$/, "")}/campaigns/_search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: { multi_match: { query: query.query, fields: ["name^3", "description", "location^2", "speciesTags", "species", "treeSpecies", "creator"] } },
        size: Math.min(Math.max(query.limit ?? 20, 1), 100),
        from: Math.max(query.offset ?? 0, 0),
      }),
    });
    if (!response.ok) throw new Error(`Campaign search unavailable (${response.status})`);
    const payload = await response.json() as { hits?: { hits?: Array<{ _score?: number; _source: CampaignRecord }> } };
    return (payload.hits?.hits ?? []).map((hit) => ({ campaign: hit._source, score: hit._score ?? 0, highlights: [] }));
  }
}

/** Batch reads are served from the campaign source in one set-based call. */
export class SourceCampaignSearchProvider implements CampaignSearchProvider {
  constructor(private readonly source: CampaignDataSource) {}

  search(query: CampaignSearchQuery): Promise<CampaignSearchResult[]> {
    return new InMemoryCampaignSearchProvider(this.source).search(query);
  }

  searchBatch(ids: string[], options?: CampaignBatchOptions): Promise<CampaignBatchResult> {
    return readCampaignBatch(this.source, ids, options);
  }
}
