"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Sponsor, SponsorTier, INITIAL_MOCK_SPONSORS, calculateSponsorTier } from "@/types/sponsor";
import {
  SponsorPortfolio,
  SponsorPortfolioEntry,
  PortfolioReconciliationStatus,
  PortfolioSourceReference,
  buildSponsorPortfolio,
  EMPTY_SPONSOR_PORTFOLIO,
} from "@/types/sponsor-portfolio";

export interface UseSponsorWallOptions {
  campaignId: string;
  enableLiveUpdates?: boolean;
  pollIntervalMs?: number;
  /**
   * Authoritative portfolio records fetched from the portfolio API.
   * When omitted, the hook falls back to the local mock sponsors so the
   * wall keeps rendering (with an explicit `unavailable` reconciliation
   * status) instead of silently showing stale numbers.
   */
  portfolio?: SponsorPortfolio | null;
  /** Error surfaced by the portfolio fetch, if any. */
  portfolioError?: Error | null;
  /** Whether the portfolio fetch is currently in flight. */
  isPortfolioLoading?: boolean;
  /** Retry the authoritative portfolio fetch. */
  onRetryPortfolio?: () => void;
}

const SAMPLE_NAMES = [
  "Nova Stellar Fund", "Cosmos Capital", "Aria Thorne", "Zane Sterling",
  "BioTree Foundation", "Solaris Global", "Lyra Vance", "Hyperion Eco"
];

export function useSponsorWall({
  campaignId,
  enableLiveUpdates = true,
  pollIntervalMs = 6000,
  portfolio,
  portfolioError = null,
  isPortfolioLoading = false,
  onRetryPortfolio,
}: UseSponsorWallOptions) {
  const [sponsors, setSponsors] = useState<Sponsor[]>(INITIAL_MOCK_SPONSORS);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTier, setSelectedTier] = useState<SponsorTier | "ALL">("ALL");
  const [sortBy, setSortBy] = useState<"RECENT" | "AMOUNT">("RECENT");
  const [isLiveActive, setIsLiveActive] = useState(enableLiveUpdates);
  const [latestNewSponsor, setLatestNewSponsor] = useState<Sponsor | null>(null);

  // Simulated live incoming sponsorship stream
  useEffect(() => {
    if (!isLiveActive) return;

    const interval = setInterval(() => {
      const randomAmount = Math.floor(Math.random() * 3000) + 100;
      const amountStr = randomAmount.toString();
      const randomName = SAMPLE_NAMES[Math.floor(Math.random() * SAMPLE_NAMES.length)];
      const randomAddr = `G${Math.random().toString(36).substring(2, 6).toUpperCase()}...${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

      const newSponsor: Sponsor = {
        id: `sp-${Date.now()}`,
        campaignId,
        name: randomName,
        address: randomAddr,
        amount: amountStr,
        token: Math.random() > 0.5 ? "XLM" : "USDC",
        tier: calculateSponsorTier(amountStr),
        sponsoredAt: Date.now(),
        message: "Live sponsorship via Stellar Client OS!",
        isRecent: true,
      };

      setSponsors((prev) => [newSponsor, ...prev]);
      setLatestNewSponsor(newSponsor);

      // Reset recent glow highlight after 4 seconds
      setTimeout(() => {
        setSponsors((prev) =>
          prev.map((s) => (s.id === newSponsor.id ? { ...s, isRecent: false } : s))
        );
      }, 4000);
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [isLiveActive, campaignId, pollIntervalMs]);

  const addSponsor = useCallback((sponsor: Omit<Sponsor, "id" | "sponsoredAt" | "tier">) => {
    const tier = calculateSponsorTier(sponsor.amount);
    const newEntry: Sponsor = {
      ...sponsor,
      id: `sp-${Date.now()}`,
      tier,
      sponsoredAt: Date.now(),
      isRecent: true,
    };

    setSponsors((prev) => [newEntry, ...prev]);
    setLatestNewSponsor(newEntry);
  }, []);

  const filteredSponsors = useMemo(() => {
    return sponsors
      .filter((s) => {
        if (selectedTier !== "ALL" && s.tier !== selectedTier) return false;
        if (searchQuery.trim()) {
          const query = searchQuery.toLowerCase();
          const nameMatch = s.name?.toLowerCase().includes(query);
          const addrMatch = s.address.toLowerCase().includes(query);
          if (!nameMatch && !addrMatch) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === "AMOUNT") {
          return parseFloat(b.amount) - parseFloat(a.amount);
        }
        return b.sponsoredAt - a.sponsoredAt;
      });
  }, [sponsors, selectedTier, searchQuery, sortBy]);

  const stats = useMemo(() => {
    const totalSponsors = sponsors.length;
    const totalRaised = sponsors.reduce((acc, s) => acc + parseFloat(s.amount), 0);
    const highestSponsorship = sponsors.reduce(
      (max, s) => Math.max(max, parseFloat(s.amount)),
      0
    );

    return {
      totalSponsors,
      totalRaised,
      highestSponsorship,
    };
  }, [sponsors]);

  /**
   * Authoritative portfolio. When the caller supplies a portfolio we use it
   * verbatim (it is the source of truth). Otherwise we derive a portfolio
   * from the local mock sponsors and mark it as `unavailable` so the UI can
   * surface that committed/matched/settled values are not reconciled.
   */
  const resolvedPortfolio = useMemo<SponsorPortfolio>(() => {
    if (portfolio) return portfolio;
    return buildSponsorPortfolio({
      campaignId,
      entries: sponsors.map((s) => ({
        sponsorId: s.id,
        name: s.name,
        address: s.address,
        token: s.token,
        committedAmount: s.amount,
        matchedAmount: "0",
        settledAmount: "0",
        sponsoredAt: s.sponsoredAt,
        sources: [],
      })),
      reconciliationStatus: "unavailable",
      reconciliationMessage:
        "Portfolio records are not available; showing local entries only.",
    });
  }, [portfolio, campaignId, sponsors]);

  const portfolioEntries = useMemo<SponsorPortfolioEntry[]>(
    () => resolvedPortfolio.entries,
    [resolvedPortfolio]
  );

  const reconciliationStatus: PortfolioReconciliationStatus = useMemo(() => {
    if (portfolioError) return "error";
    if (isPortfolioLoading) return "pending";
    return resolvedPortfolio.reconciliationStatus;
  }, [portfolioError, isPortfolioLoading, resolvedPortfolio.reconciliationStatus]);

  const sourceReferences = useMemo<PortfolioSourceReference[]>(
    () => resolvedPortfolio.sourceReferences,
    [resolvedPortfolio]
  );

  const portfolioTotals = useMemo(
    () => ({
      committed: resolvedPortfolio.totals.committed,
      matched: resolvedPortfolio.totals.matched,
      settled: resolvedPortfolio.totals.settled,
      currency: resolvedPortfolio.totals.currency,
      entryCount: resolvedPortfolio.totals.entryCount,
    }),
    [resolvedPortfolio]
  );

  const retryPortfolio = useCallback(() => {
    onRetryPortfolio?.();
  }, [onRetryPortfolio]);

  return {
    sponsors: filteredSponsors,
    allSponsors: sponsors,
    stats,
    searchQuery,
    setSearchQuery,
    selectedTier,
    setSelectedTier,
    sortBy,
    setSortBy,
    isLiveActive,
    setIsLiveActive,
    latestNewSponsor,
    addSponsor,
    // Portfolio (committed / matched / settled) + reconciliation surface
    portfolio: resolvedPortfolio,
    portfolioEntries,
    portfolioTotals,
    reconciliationStatus,
    reconciliationMessage: portfolioError
      ? portfolioError.message
      : resolvedPortfolio.reconciliationMessage,
    sourceReferences,
    isPortfolioLoading,
    retryPortfolio,
  };
}
