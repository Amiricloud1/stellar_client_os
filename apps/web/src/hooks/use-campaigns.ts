"use client";

import { useState, useEffect } from "react";
import { CampaignRecord } from "@/services/campaign.service";
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
const PAGE_SIZE = 500;

export function useCampaigns() {
  const defaultCampaigns = [
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
      description: "Protecting 50,000 hectares of primary rainforest through community-led guardianship and carbon streaming.",
      endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(), // Expires in 5 days
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
      description: "Installing 12 solar-powered water filtration wells across rural farming villages.",
    },
  ];

  const [campaigns, setCampaigns] = useState<any[]>(defaultCampaigns);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const { isOnline } = useSyncQueue();

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

