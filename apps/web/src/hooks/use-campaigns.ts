"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { safeGetItem, safeSetItem } from "@/utils/safe-storage";
import { useSyncQueue } from "./use-sync-queue";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Query key namespace for campaign list data. */
export const CAMPAIGNS_QUERY_KEY = ["campaigns"] as const;

/** Maximum records per page when loading from the API. */
const PAGE_SIZE = 500;

/** localStorage key used for offline fallback cache. */
const CACHE_KEY = "campaigns_cache";

/**
 * How long campaign list data is considered fresh (1 minute).
 * During this window a mounted component will not re-fetch in the background.
 */
const CAMPAIGNS_STALE_TIME = 60_000;

/**
 * How long campaigns stay in the React Query cache after the last subscriber
 * unmounts (5 minutes). Keeps data warm for quick navigation.
 */
const CAMPAIGNS_GC_TIME = 5 * 60_000;

// ---------------------------------------------------------------------------
// Campaign shape returned by the hook
// ---------------------------------------------------------------------------

export interface CampaignItem {
  id: string;
  title: string;
  category: string;
  raisedAmount: string;
  goalAmount: string;
  token: string;
  sponsorCount: number;
  collaboratorCount: number;
  status: string;
  description: string;
  treeSpecies?: string;
  region?: string;
  location?: unknown;
  gpsLocations?: unknown;
  endDate?: string;
}

// ---------------------------------------------------------------------------
// Default seed data shown while the first fetch is in-flight
// ---------------------------------------------------------------------------

const DEFAULT_CAMPAIGNS: CampaignItem[] = [
  {
    id: "camp-101",
    title: "Save the Amazon RainForest Reserve",
    category: "Environmental & Reforestation",
    raisedAmount: "33,850",
    goalAmount: "50,000",
    token: "XLM",
    sponsorCount: 6,
    collaboratorCount: 2,
    status: "ACTIVE",
    description:
      "Protecting 50,000 hectares of primary rainforest through community-led guardianship and carbon streaming.",
    endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "camp-102",
    title: "Clean Water Wells for Sub-Saharan Communities",
    category: "Community & Social Impact",
    raisedAmount: "18,200",
    goalAmount: "25,000",
    token: "USDC",
    sponsorCount: 14,
    collaboratorCount: 3,
    status: "ACTIVE",
    description:
      "Installing 12 solar-powered water filtration wells across rural farming villages.",
  },
];

// ---------------------------------------------------------------------------
// Internal fetch helper (all pages)
// ---------------------------------------------------------------------------

async function fetchAllCampaigns(): Promise<CampaignItem[]> {
  let offset = 0;
  const accumulated: CampaignItem[] = [];

  while (true) {
    const res = await fetch(`/api/campaigns?limit=${PAGE_SIZE}&offset=${offset}`);
    if (!res.ok) break;

    const { data } = (await res.json()) as { data: Record<string, unknown>[] };

    const formatted: CampaignItem[] = (data ?? []).map((c) => ({
      id: String(c.id ?? ""),
      title: String(c.name ?? ""),
      category: "General",
      raisedAmount: String(c.raisedAmount ?? "0"),
      goalAmount: String(c.goalAmount ?? "0"),
      token: "XLM",
      sponsorCount: Number(c.sponsorCount ?? 0),
      collaboratorCount: 0,
      status: String(c.status ?? ""),
      description: String(c.description ?? ""),
      treeSpecies: c.treeSpecies !== undefined ? String(c.treeSpecies) : undefined,
      region: c.region !== undefined ? String(c.region) : undefined,
      location: c.location,
      gpsLocations: c.gpsLocations,
      endDate:
        c.deadline || c.endDate
          ? new Date(String(c.deadline ?? c.endDate)).toISOString()
          : undefined,
    }));

    accumulated.push(...formatted);
    offset += PAGE_SIZE;

    if (!data || data.length < PAGE_SIZE) break;
  }

  return accumulated;
}

// ---------------------------------------------------------------------------
// Public hook
// ---------------------------------------------------------------------------

/**
 * useCampaigns
 *
 * Fetches the full campaign list with React Query so staleness, background
 * refresh, offline fallback, and cache invalidation are handled declaratively.
 *
 * Freshness policy
 * ----------------
 * • staleTime: 60 s — re-uses cached data on navigation; background refetch
 *   only triggers after the window.
 * • gcTime: 5 min — keeps data alive for instant back-navigation.
 * • refetchOnWindowFocus: true — refreshes totals when the tab regains focus.
 * • refetchOnReconnect: true — refreshes after a reconnect event.
 * • Offline: when the browser is offline the query is disabled and the last
 *   localStorage snapshot is served as placeholder data so the UI never
 *   shows an empty list.
 */
export function useCampaigns() {
  const { isOnline } = useSyncQueue();
  const queryClient = useQueryClient();

  // Persist data to localStorage whenever it changes so the offline fallback
  // cache stays warm without a separate effect.
  const onSuccess = (data: CampaignItem[]) => {
    if (data.length > 0) {
      safeSetItem(CACHE_KEY, JSON.stringify(data));
    }
  };

  // Offline fallback: read the last persisted snapshot.
  const offlinePlaceholder = (): CampaignItem[] => {
    const cached = safeGetItem(CACHE_KEY);
    if (!cached) return DEFAULT_CAMPAIGNS;
    try {
      const parsed = JSON.parse(cached) as CampaignItem[];
      return parsed.length > 0 ? parsed : DEFAULT_CAMPAIGNS;
    } catch {
      return DEFAULT_CAMPAIGNS;
    }
  };

  const { data, isLoading, error, isFetching } = useQuery<CampaignItem[]>({
    queryKey: CAMPAIGNS_QUERY_KEY,
    queryFn: fetchAllCampaigns,
    // Pause fetching while offline — use the snapshot as placeholder instead.
    enabled: isOnline,
    staleTime: CAMPAIGNS_STALE_TIME,
    gcTime: CAMPAIGNS_GC_TIME,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    // Serve the last snapshot immediately while a background refresh is running.
    placeholderData: offlinePlaceholder,
    // Persist latest data to localStorage on every successful response.
    select: (campaigns) => {
      onSuccess(campaigns);
      return campaigns;
    },
  });

  /**
   * Imperatively invalidate and refetch campaign data, e.g. after a donation
   * mutation so totals are updated without waiting for the stale window.
   */
  const invalidateCampaigns = () =>
    queryClient.invalidateQueries({ queryKey: CAMPAIGNS_QUERY_KEY });

  const campaigns = data ?? offlinePlaceholder();

  return {
    campaigns,
    isLoading,
    isFetching,
    hasMore: false, // virtual-scroll pagination handled by API; hook returns all pages
    error,
    invalidateCampaigns,
  };
}

