"use client";

import { useCallback, useState } from "react";
import {
  BackerPrivacyPreference,
  BackerVisibility,
  TOP_BACKERS_LIMIT,
  TopBackersResult,
} from "@/types/campaign-backers";
import { backersService, seedDemoBackers } from "@/services/campaign-backers.service";
import type { PageInfo, PaginationParams, SortParams } from "@/types/pagination";

export interface UseTopBackersOptions {
  campaignId: string;
  /** Address of the person viewing the page. */
  viewerAddress?: string;
  /** Campaign creator address — creators may feature backers. */
  creatorAddress?: string;
  /** Page size. Defaults to TOP_BACKERS_LIMIT and is clamped by the service. */
  limit?: number;
  /** 1-based page number. Defaults to 1. */
  page?: number;
  /** Sort field/direction; defaults to the leaderboard's stable ranking. */
  sort?: SortParams;
  /** Seed the mock campaign's demo backers (campaign detail page demo data). */
  seedDemoData?: boolean;
}

const sameAddress = (a?: string, b?: string) =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/**
 * Top backers leaderboard — ranks a campaign's backers by total contribution,
 * lets the creator feature up to a handful of them, and applies each backer's
 * privacy preference before anything reaches the UI.
 */
export function useTopBackers({
  campaignId,
  viewerAddress,
  creatorAddress,
  limit = TOP_BACKERS_LIMIT,
  page = 1,
  sort,
  seedDemoData = true,
}: UseTopBackersOptions) {
  const [prevCampaignId, setPrevCampaignId] = useState(campaignId);
  const [error, setError] = useState<string | null>(null);

  const loadResult = useCallback((): TopBackersResult => {
    if (seedDemoData) seedDemoBackers(campaignId);
    const pagination: PaginationParams = { page, limit };
    return backersService.getTopBackers(campaignId, {
      pagination,
      sort,
      viewerAddress,
      creatorAddress,
    });
  }, [campaignId, page, limit, sort, viewerAddress, creatorAddress, seedDemoData]);

  const [result, setResult] = useState<TopBackersResult>(loadResult);

  if (prevCampaignId !== campaignId) {
    setPrevCampaignId(campaignId);
    setResult(loadResult());
    setError(null);
  }

  // Refresh the leaderboard without touching the current error banner — the
  // caller decides whether an action succeeded.
  const reload = useCallback(() => {
    setResult(loadResult());
  }, [loadResult]);

  const creator = creatorAddress ?? backersService.getCampaignCreator(campaignId) ?? undefined;
  const isCreator = sameAddress(viewerAddress, creator);

  const toggleFeatured = useCallback(
    (backerAddress: string, note?: string) => {
      if (!viewerAddress) {
        const message = "Connect your wallet to feature backers";
        setError(message);
        return { ok: false as const, error: message };
      }

      const outcome = backersService.toggleFeatured({
        campaignId,
        backerAddress,
        featuredBy: viewerAddress,
        campaignCreator: creator,
        note,
      });
      setError(outcome.ok ? null : outcome.error);
      reload();
      return outcome;
    },
    [campaignId, viewerAddress, creator, reload],
  );

  const setPrivacy = useCallback(
    (
      backerAddress: string,
      update: { visibility?: BackerVisibility; showAmount?: boolean; allowFeaturing?: boolean },
    ) => {
      try {
        const outcome = backersService.setPrivacyPreference({
          campaignId,
          backerAddress,
          ...update,
        });
        setError(null);
        reload();
        return { ok: true as const, ...outcome };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to update privacy preference";
        setError(message);
        return { ok: false as const, error: message };
      }
    },
    [campaignId, reload],
  );

  // Match on the service's `isSelf` flag rather than the address: an anonymous
  // row has its address redacted, so address matching would lose the viewer's
  // own entry (and with it their privacy controls).
  const myEntry = result.backers.find((entry) => entry.isSelf);

  const myPrivacy: BackerPrivacyPreference | undefined = viewerAddress
    ? backersService.getPrivacyPreference(campaignId, viewerAddress)
    : undefined;

  // Shared pagination metadata (issue #59). Falls back to a single-page
  // descriptor when the service omits it so callers can rely on it always
  // being present.
  const pageInfo: PageInfo = result.pageInfo ?? {
    page,
    limit,
    total: result.totalBackers,
    totalPages: Math.max(1, Math.ceil(result.totalBackers / Math.max(1, limit))),
    hasNextPage: false,
    hasPreviousPage: page > 1,
  };

  return {
    result,
    backers: result.backers,
    totalBackers: result.totalBackers,
    privateBackers: result.privateBackers,
    totalAmount: result.totalAmount,
    featuredCount: result.featuredCount,
    pageInfo,
    isCreator,
    creatorAddress: creator,
    myEntry,
    myPrivacy,
    error,
    toggleFeatured,
    setPrivacy,
    reload,
  };
}
