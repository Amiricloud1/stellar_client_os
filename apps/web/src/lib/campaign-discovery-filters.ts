export const DISCOVERY_TREE_SPECIES = ["Oak", "Pine", "Mangrove"] as const;
export const DISCOVERY_REGIONS = ["North America", "Africa", "Asia"] as const;
export const DISCOVERY_ALL_OPTION = "All" as const;

export type DiscoveryTreeSpecies = (typeof DISCOVERY_TREE_SPECIES)[number];
export type DiscoveryRegion = (typeof DISCOVERY_REGIONS)[number];
export type DiscoveryAllOption = typeof DISCOVERY_ALL_OPTION;

export interface CampaignDiscoveryRecord {
  treeSpecies?: string;
  region?: string;
  location?: string;
  gpsLocations?: Array<{ latitude: number; longitude: number }>;
}

export interface CampaignDiscoveryFilters {
  treeSpecies: DiscoveryTreeSpecies | DiscoveryAllOption;
  region: DiscoveryRegion | DiscoveryAllOption;
}

export const DEFAULT_CAMPAIGN_DISCOVERY_FILTERS: CampaignDiscoveryFilters = {
  treeSpecies: DISCOVERY_ALL_OPTION,
  region: DISCOVERY_ALL_OPTION,
};

const REGION_LOCATION_TERMS: Record<DiscoveryRegion, string[]> = {
  "North America": [
    "north america", "united states", "usa", "u.s.a.", "canada", "mexico", "greenland",
    "guatemala", "belize", "honduras", "el salvador", "nicaragua", "costa rica", "panama",
    "cuba", "jamaica", "haiti", "dominican republic", "puerto rico",
  ],
  Africa: [
    "africa", "algeria", "angola", "benin", "botswana", "burkina faso", "burundi", "cameroon",
    "chad", "congo", "djibouti", "egypt", "eritrea", "ethiopia", "ghana", "ivory coast",
    "kenya", "madagascar", "malawi", "mali", "mauritania", "mauritius", "morocco", "mozambique",
    "namibia", "niger", "nigeria", "rwanda", "senegal", "somalia", "south africa", "sudan",
    "tanzania", "togo", "tunisia", "uganda", "zambia", "zimbabwe",
  ],
  Asia: [
    "asia", "afghanistan", "armenia", "azerbaijan", "bahrain", "bangladesh", "bhutan", "brunei",
    "cambodia", "china", "cyprus", "georgia", "india", "indonesia", "iran", "iraq", "israel",
    "japan", "jordan", "kazakhstan", "kuwait", "kyrgyzstan", "laos", "lebanon", "malaysia",
    "maldives", "mongolia", "myanmar", "nepal", "north korea", "oman", "pakistan", "palestine",
    "philippines", "qatar", "saudi arabia", "singapore", "south korea", "sri lanka", "syria",
    "taiwan", "tajikistan", "thailand", "timor-leste", "turkey", "turkmenistan", "united arab emirates",
    "uzbekistan", "vietnam", "yemen",
  ],
};

function regionFromCoordinates(latitude: number, longitude: number): DiscoveryRegion | undefined {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined;
  if (latitude >= 7 && latitude <= 84 && longitude >= -170 && longitude <= -50) return "North America";
  if (latitude >= -35 && latitude <= 37 && longitude >= -18 && longitude <= 52) return "Africa";
  if (latitude >= -10 && latitude <= 80 && longitude >= 25 && longitude <= 180) return "Asia";
  return undefined;
}

export function getCampaignDiscoveryRegion(campaign: CampaignDiscoveryRecord): DiscoveryRegion | undefined {
  const explicitRegion = DISCOVERY_REGIONS.find(
    (region) => campaign.region?.trim().toLowerCase() === region.toLowerCase(),
  );
  if (explicitRegion) return explicitRegion;

  for (const point of campaign.gpsLocations ?? []) {
    const region = regionFromCoordinates(point.latitude, point.longitude);
    if (region) return region;
  }

  const location = campaign.location?.trim().toLowerCase();
  if (!location) return undefined;
  return DISCOVERY_REGIONS.find((region) =>
    REGION_LOCATION_TERMS[region].some((term) => location.includes(term)),
  );
}

function normalizeSpecies(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+trees?$/, "")
    .replace(/s$/, "");
}

function campaignHasSpecies(campaign: CampaignDiscoveryRecord, selected: DiscoveryTreeSpecies): boolean {
  const normalizedSelected = normalizeSpecies(selected);
  return (campaign.treeSpecies ?? "")
    .split(/[,;/|]/)
    .map(normalizeSpecies)
    .filter((species) => species.length > 0)
    .includes(normalizedSelected);
}

export function campaignMatchesDiscoveryFilters(
  campaign: CampaignDiscoveryRecord,
  filters: CampaignDiscoveryFilters,
): boolean {
  const matchesSpecies =
    filters.treeSpecies === DISCOVERY_ALL_OPTION || campaignHasSpecies(campaign, filters.treeSpecies);
  const matchesRegion =
    filters.region === DISCOVERY_ALL_OPTION || getCampaignDiscoveryRegion(campaign) === filters.region;
  return matchesSpecies && matchesRegion;
}

export function filterCampaignsByDiscoveryOptions<T extends CampaignDiscoveryRecord>(
  campaigns: T[],
  filters: CampaignDiscoveryFilters,
): T[] {
  return campaigns.filter((campaign) => campaignMatchesDiscoveryFilters(campaign, filters));
}

/**
 * Extended Discovery Filter Facets & Shareable URL State (Issues #173, #174, #175, #245)
 * Composes validated category, status, location, and asset filters in stable,
 * shareable URLs with deterministic pagination reset.
 */
export interface DiscoveryFacetFilters {
  category: string;
  status: string;
  location: string;
  asset: string;
  page: number;
  sortBy: string;
}

export const DEFAULT_DISCOVERY_FACETS: DiscoveryFacetFilters = {
  category: "All",
  status: "All",
  location: "All",
  asset: "All",
  page: 1,
  sortBy: "trending",
};

const VALID_STATUSES = new Set(["All", "Active", "Paused", "Successful", "Failed", "Claimed"]);
const VALID_SORT_OPTIONS = new Set(["trending", "newest", "progress", "target"]);

/**
 * Parse and validate URL search parameters into a safe DiscoveryFacetFilters object.
 */
export function parseDiscoveryUrlParams(
  params: URLSearchParams | Record<string, string | string[] | undefined>
): DiscoveryFacetFilters {
  const getParam = (key: string): string | undefined => {
    if (params instanceof URLSearchParams) {
      return params.get(key) || undefined;
    }
    const val = params[key];
    if (Array.isArray(val)) return val[0];
    return val;
  };

  const rawCategory = getParam("category")?.trim();
  const rawStatus = getParam("status")?.trim();
  const rawLocation = getParam("location")?.trim();
  const rawAsset = getParam("asset")?.trim();
  const rawPage = parseInt(getParam("page") || "1", 10);
  const rawSort = getParam("sortBy")?.trim();

  return {
    category: rawCategory && rawCategory.length > 0 ? rawCategory : DEFAULT_DISCOVERY_FACETS.category,
    status: rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus : DEFAULT_DISCOVERY_FACETS.status,
    location: rawLocation && rawLocation.length > 0 ? rawLocation : DEFAULT_DISCOVERY_FACETS.location,
    asset: rawAsset && rawAsset.length > 0 ? rawAsset : DEFAULT_DISCOVERY_FACETS.asset,
    page: !isNaN(rawPage) && rawPage > 0 ? rawPage : 1,
    sortBy: rawSort && VALID_SORT_OPTIONS.has(rawSort) ? rawSort : DEFAULT_DISCOVERY_FACETS.sortBy,
  };
}

/**
 * Serializes DiscoveryFacetFilters into URLSearchParams.
 * Automatically resets pagination to page 1 if any filter facet has changed.
 */
export function serializeDiscoveryUrlParams(
  newFilters: DiscoveryFacetFilters,
  prevFilters?: DiscoveryFacetFilters
): URLSearchParams {
  const params = new URLSearchParams();

  const facetChanged =
    prevFilters &&
    (prevFilters.category !== newFilters.category ||
      prevFilters.status !== newFilters.status ||
      prevFilters.location !== newFilters.location ||
      prevFilters.asset !== newFilters.asset ||
      prevFilters.sortBy !== newFilters.sortBy);

  const effectivePage = facetChanged ? 1 : Math.max(1, newFilters.page);

  if (newFilters.category !== "All") params.set("category", newFilters.category);
  if (newFilters.status !== "All") params.set("status", newFilters.status);
  if (newFilters.location !== "All") params.set("location", newFilters.location);
  if (newFilters.asset !== "All") params.set("asset", newFilters.asset);
  if (newFilters.sortBy !== "trending") params.set("sortBy", newFilters.sortBy);
  if (effectivePage > 1) params.set("page", String(effectivePage));

  return params;
}

