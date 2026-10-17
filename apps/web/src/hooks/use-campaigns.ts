"use client";

import { useState, useEffect } from "react";
import { CampaignRecord } from "@/services/campaign.service";
import { useSyncQueue } from "./use-sync-queue";

// ---------------------------------------------------------------------------
// Page size used when fetching from the API.
// Virtual scrolling makes it safe to load large pages because only the
// currently-visible cards are in the DOM.  We fetch up to 500 at a time and
// append on scroll (infinite load pattern) to support 10k+ campaign lists
// without a single blocking request.
//
// Issue #59: pagination and sorting are standardized across list endpoints.
// The API enforces a maximum page size (see shared pagination contract), so
// this value is clamped to the server-advertised limit when one is returned.
// ---------------------------------------------------------------------------
const PAGE_SIZE = 500;

// Stable default ordering shared with the other list endpoints (campaigns,
// backers, audit, analytics).  `createdAt` is unique per campaign so the
// ordering is deterministic across pages.
const DEFAULT_SORT = "createdAt";
const DEFAULT_ORDER = "desc";

export interface PageInfo {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
  sort: string;
  order: "asc" | "desc";
}

export interface UseCampaignsOptions {
  /** Page size requested from the API (clamped to the server max). */
  limit?: number;
  /** Field to sort by; must be one of the shared sortable fields. */
  sort?: string;
  /** Sort direction. */
  order?: "asc" | "desc";
}

const DEFAULT_PAGE_INFO: PageInfo = {
  limit: PAGE_SIZE,
  offset: 0,
  total: 0,
  hasMore: true,
  sort: DEFAULT_SORT,
  order: DEFAULT_ORDER,
};

export function useCampaigns(options: UseCampaignsOptions = {}) {
  const {
    limit: requestedLimit = PAGE_SIZE,
    sort = DEFAULT_SORT,
    order = DEFAULT_ORDER,
  } = options;
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
  const [pageInfo, setPageInfo] = useState<PageInfo>({
    ...DEFAULT_PAGE_INFO,
    limit: requestedLimit,
    sort,
    order,
  });
  const { isOnline } = useSyncQueue();

  useEffect(() => {
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
      let pageLimit = requestedLimit;
      const accumulated: any[] = [];
      let lastPageInfo: PageInfo | null = null;

      try {
        while (true) {
          const params = new URLSearchParams({
            limit: String(pageLimit),
            offset: String(offset),
            sort,
            order,
          });
          const res = await fetch(`/api/campaigns?${params.toString()}`);
          if (!res.ok) break;

          const { data, pagination } = await res.json();

          // Issue #59: the API returns shared PageInfo metadata.  Use it as
          // the source of truth for the effective limit, total count and
          // whether more pages exist, so ordering stays stable across pages.
          if (pagination) {
            lastPageInfo = {
              limit: pagination.limit ?? pageLimit,
              offset: pagination.offset ?? offset,
              total: pagination.total ?? 0,
              hasMore: Boolean(pagination.hasMore),
              sort: pagination.sort ?? sort,
              order: pagination.order ?? order,
            };
            // Respect the server-advertised max page size on subsequent pages.
            pageLimit = lastPageInfo.limit;
          }

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
          offset += pageLimit;

          // Prefer the server's PageInfo to decide whether to continue; fall
          // back to the short-page heuristic for older API responses.
          const more = lastPageInfo
            ? lastPageInfo.hasMore
            : Boolean(data) && data.length >= pageLimit;

          if (!more) {
            setHasMore(false);
            break;
          }
        }

        if (lastPageInfo) {
          setPageInfo(lastPageInfo);
        }

        if (accumulated.length > 0) {
          setCampaigns(accumulated);
          localStorage.setItem("campaigns_cache", JSON.stringify(accumulated));
        }
      } catch (e) {
        console.error("Failed to fetch campaigns", e);
      } finally {
        setIsLoading(false);
      }
    };

    fetchCampaigns();
  }, [isOnline, requestedLimit, sort, order]);

  return { campaigns, isLoading, hasMore, pageInfo };
}

