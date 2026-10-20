"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { safeGetItem, safeSetItem } from "@/utils/safe-storage";
import { useSyncQueue } from "./use-sync-queue";

// ---------------------------------------------------------------------------
// E2E fixture injection.
//
// When running under Playwright (or any E2E harness) we must not depend on
// live network data or real funds.  The harness sets a global fixture on
// `window.__E2E_CAMPAIGNS__` before the app boots; when present we use it
// verbatim and skip all fetching/caching.  This is a no-op in production
// because the global is never defined there.
// ---------------------------------------------------------------------------
export type CampaignsFixture = {
  campaigns?: any[];
  /** Simulate a failed fetch so the error state can be asserted. */
  error?: boolean;
  /** Simulate a pending fetch so the loading state can be asserted. */
  loading?: boolean;
};

function readFixture(): CampaignsFixture | null {
  if (typeof window === "undefined") return null;
  const fixture = (window as any).__E2E_CAMPAIGNS__;
  return fixture && typeof fixture === "object" ? (fixture as CampaignsFixture) : null;
}

// ---------------------------------------------------------------------------
// Page size used when fetching from the API.
// Virtual scrolling makes it safe to load large pages because only the
// currently-visible cards are in the DOM.  We fetch up to 500 at a time and
// append on scroll (infinite load pattern) to support 10k+ campaign lists
// without a single blocking request.
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

  const [campaigns, setCampaigns] = useState<any[]>(defaultCampaigns);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const { isOnline } = useSyncQueue();
  const queryClient = useQueryClient();

  useEffect(() => {
    // 0. Deterministic E2E fixtures take precedence over cache and network.
    const fixture = readFixture();
    if (fixture) {
      if (fixture.error) {
        setError(new Error("Failed to fetch campaigns"));
        setIsLoading(false);
        setHasMore(false);
        return;
      }
      if (fixture.loading) {
        setIsLoading(true);
        return;
      }
      setCampaigns(fixture.campaigns ?? []);
      setHasMore(false);
      setIsLoading(false);
      setError(null);
      return;
    }

    // 1. Load from cache first for fast offline access
    const cached = localStorage.getItem("campaigns_cache");
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.length > 0) {
          setCampaigns(parsed);
        }
      } catch (e) {
        console.error("Failed to parse cached campaigns", e);
      }
    }

    // 2. Fetch fresh data if online — loads in large pages to support virtual
    //    scrolling over 10k+ campaigns (issue #914).
    const fetchCampaigns = async () => {
      if (!navigator.onLine) {
        setIsLoading(false);
        return;
      }

      let offset = 0;
      const accumulated: any[] = [];

      try {
        while (true) {
          const res = await fetch(`/api/campaigns?limit=${PAGE_SIZE}&offset=${offset}`);
          if (!res.ok) {
            setError(new Error(`Failed to fetch campaigns (${res.status})`));
            break;
          }

          const { data, pagination } = await res.json();

          // Map backend records to UI format
          const formatted = (data as any[]).map((c) => ({
            id: c.id,
            title: c.name,
            category: "General", // Placeholder if not in API
            raisedAmount: c.raisedAmount || "0",
            goalAmount: c.goalAmount,
            token: "XLM",
            sponsorCount: c.sponsorCount || 0,
            collaboratorCount: 0,
            status: c.status,
            description: c.description || "",
            treeSpecies: c.treeSpecies,
            region: c.region,
            location: c.location,
            gpsLocations: c.gpsLocations,
            endDate: c.endDate || c.deadline ? new Date(c.deadline || c.endDate).toISOString() : undefined,
          }));

          accumulated.push(...formatted);
          offset += PAGE_SIZE;

          // Stop when the API returns fewer items than the page size,
          // meaning we've fetched all available campaigns.
          if (!data || data.length < PAGE_SIZE) {
            setHasMore(false);
            break;
          }
        }

        if (accumulated.length > 0) {
          setCampaigns(accumulated);
          setError(null);
          localStorage.setItem("campaigns_cache", JSON.stringify(accumulated));
        }
      } catch (e) {
        console.error("Failed to fetch campaigns", e);
        setError(e instanceof Error ? e : new Error("Failed to fetch campaigns"));
      } finally {
        setIsLoading(false);
      }
    };

    fetchCampaigns();
  }, [isOnline]);

  return { campaigns, isLoading, hasMore, error };
}

