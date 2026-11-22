import { formatTokenAmount, parseTokenAmount } from "@/types/campaign-backers";

export type SponsorshipTier = "NONE" | "TREE_10" | "TREE_50" | "TREE_100";

export type SponsorshipValueClass = "COMMITTED" | "MATCHED" | "SETTLED";

export type SponsorshipSourceKind = "RECORD" | "ON_CHAIN_EVENT" | "RECEIPT";

export type SponsorshipReconciliationStatus =
  | "RECONCILED"
  | "PARTIAL"
  | "UNRECONCILED"
  | "ZERO";

export interface SponsorshipSourceReference {
  kind: SponsorshipSourceKind;
  /** Stable identifier of the authoritative source (record id, tx hash, receipt id). */
  id: string;
  /** Campaign the source belongs to, when known. */
  campaignId: string | null;
  /** Amount attributed to this source in token scale, or null when unknown. */
  amount: string | null;
  /** Whether this source was successfully matched to the authoritative record. */
  reconciled: boolean;
  /** Optional human-readable note explaining an unreconciled source. */
  note?: string;
}

export interface SponsorPortfolioCampaign {
  campaignId: string;
  committedAmount: string;
  matchedAmount: string;
  settledAmount: string;
  reconciliationStatus: SponsorshipReconciliationStatus;
  sources: SponsorshipSourceReference[];
}

export interface SponsorPortfolio {
  sponsorId: string;
  campaigns: SponsorPortfolioCampaign[];
  totals: {
    committedAmount: string;
    matchedAmount: string;
    settledAmount: string;
  };
  reconciliationStatus: SponsorshipReconciliationStatus;
  /** True when at least one source could not be reconciled. */
  hasUnreconciledSources: boolean;
}

export interface SponsorshipRecord {
  id: string;
  campaignId: string;
  sponsorId: string;
  amount: string;
  valueClass: SponsorshipValueClass;
}

export interface SponsorshipOnChainEvent {
  txHash: string;
  campaignId: string;
  sponsorId: string;
  amount: string;
  valueClass: SponsorshipValueClass;
}

export interface SponsorshipReceipt {
  id: string;
  campaignId: string;
  sponsorId: string;
  amount: string;
  valueClass: SponsorshipValueClass;
  /** Record id this receipt is expected to settle, when known. */
  recordId?: string | null;
}

export interface SponsorPortfolioQuery {
  sponsorId: string;
  campaignIds?: string[];
}

export interface SponsorPortfolioDataSource {
  listRecords(query: SponsorPortfolioQuery): Promise<SponsorshipRecord[]>;
  listOnChainEvents(query: SponsorPortfolioQuery): Promise<SponsorshipOnChainEvent[]>;
  listReceipts(query: SponsorPortfolioQuery): Promise<SponsorshipReceipt[]>;
}

export interface SponsorPortfolioOptions {
  /** Maximum attempts per source when a query fails transiently. Defaults to 3. */
  maxAttempts?: number;
  /** Base delay in ms between retries. Defaults to 0 (no delay). */
  retryDelayMs?: number;
  /** Optional sleep implementation, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class SponsorPortfolioAuthorizationError extends Error {
  constructor(message = "Not authorized to read sponsor portfolio") {
    super(message);
    this.name = "SponsorPortfolioAuthorizationError";
  }
}

export class SponsorPortfolioQueryError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SponsorPortfolioQueryError";
  }
}

export interface SponsorshipPricing {
  treeCount: number;
  tier: SponsorshipTier;
  discountRateBps: number;
  discountPercent: number;
  grossAmount: string;
  discountAmount: string;
  netAmount: string;
}

export function getSponsorshipTier(treeCount: number): { tier: SponsorshipTier; discountRateBps: number } {
  if (!Number.isSafeInteger(treeCount) || treeCount < 1) {
    throw new Error("treeCount must be a positive integer");
  }
  if (treeCount >= 100) return { tier: "TREE_100", discountRateBps: 2500 };
  if (treeCount >= 50) return { tier: "TREE_50", discountRateBps: 1500 };
  if (treeCount >= 10) return { tier: "TREE_10", discountRateBps: 500 };
  return { tier: "NONE", discountRateBps: 0 };
}

/** Calculate the net amount using the repository's 7-decimal Stellar token scale. */
export function calculateSponsorshipPricing(grossAmount: string, treeCount: number): SponsorshipPricing {
  const parsed = parseTokenAmount(grossAmount);
  if (parsed === null || parsed <= 0n) throw new Error("A positive gross amount is required");
  const { tier, discountRateBps } = getSponsorshipTier(treeCount);
  const discount = (parsed * BigInt(discountRateBps)) / 10_000n;
  const net = parsed - discount;
  return {
    treeCount,
    tier,
    discountRateBps,
    discountPercent: discountRateBps / 100,
    grossAmount: formatTokenAmount(parsed),
    discountAmount: formatTokenAmount(discount),
    netAmount: formatTokenAmount(net),
  };
}

const ZERO_AMOUNT = "0";

function parseAmountOrNull(amount: string | null | undefined): bigint | null {
  if (amount === null || amount === undefined) return null;
  const parsed = parseTokenAmount(amount);
  if (parsed === null || parsed < 0n) return null;
  return parsed;
}

async function withRetry<T>(
  operation: () => Promise<T>,
  label: string,
  options: SponsorPortfolioOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const delay = Math.max(0, options.retryDelayMs ?? 0);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && delay > 0) {
        await sleep(delay * attempt);
      }
    }
  }
  throw new SponsorPortfolioQueryError(`Failed to load ${label} after ${maxAttempts} attempt(s)`, lastError);
}

function classifyStatus(
  hasUnreconciled: boolean,
  hasAnyValue: boolean,
): SponsorshipReconciliationStatus {
  if (!hasAnyValue) return "ZERO";
  if (hasUnreconciled) return "PARTIAL";
  return "RECONCILED";
}

/**
 * Build a sponsor portfolio across supported campaigns by reconciling committed,
 * matched, and settled value against authoritative records, on-chain events, and
 * receipts. Every amount carries a source reference so operators can audit it.
 */
export async function getSponsorPortfolio(
  query: SponsorPortfolioQuery,
  dataSource: SponsorPortfolioDataSource,
  options: SponsorPortfolioOptions = {},
): Promise<SponsorPortfolio> {
  if (!query || typeof query.sponsorId !== "string" || query.sponsorId.trim() === "") {
    throw new SponsorPortfolioAuthorizationError("A sponsorId is required to read a portfolio");
  }

  const [records, events, receipts] = await Promise.all([
    withRetry(() => dataSource.listRecords(query), "sponsorship records", options),
    withRetry(() => dataSource.listOnChainEvents(query), "on-chain events", options),
    withRetry(() => dataSource.listReceipts(query), "receipts", options),
  ]);

  const campaignFilter = query.campaignIds ? new Set(query.campaignIds) : null;
  const inScope = (campaignId: string) => !campaignFilter || campaignFilter.has(campaignId);

  const campaigns = new Map<
    string,
    {
      committed: bigint;
      matched: bigint;
      settled: bigint;
      sources: SponsorshipSourceReference[];
      unreconciled: boolean;
    }
  >();

  const ensureCampaign = (campaignId: string) => {
    let entry = campaigns.get(campaignId);
    if (!entry) {
      entry = { committed: 0n, matched: 0n, settled: 0n, sources: [], unreconciled: false };
      campaigns.set(campaignId, entry);
    }
    return entry;
  };

  const addValue = (
    entry: { committed: bigint; matched: bigint; settled: bigint },
    valueClass: SponsorshipValueClass,
    amount: bigint,
  ) => {
    if (valueClass === "COMMITTED") entry.committed += amount;
    else if (valueClass === "MATCHED") entry.matched += amount;
    else entry.settled += amount;
  };

  const recordIds = new Set<string>();
  for (const record of records) {
    if (record.sponsorId !== query.sponsorId || !inScope(record.campaignId)) continue;
    recordIds.add(record.id);
    const entry = ensureCampaign(record.campaignId);
    const amount = parseAmountOrNull(record.amount);
    if (amount === null) {
      entry.unreconciled = true;
      entry.sources.push({
        kind: "RECORD",
        id: record.id,
        campaignId: record.campaignId,
        amount: null,
        reconciled: false,
        note: "Record amount could not be parsed",
      });
      continue;
    }
    addValue(entry, record.valueClass, amount);
    entry.sources.push({
      kind: "RECORD",
      id: record.id,
      campaignId: record.campaignId,
      amount: formatTokenAmount(amount),
      reconciled: true,
    });
  }

  for (const event of events) {
    if (event.sponsorId !== query.sponsorId || !inScope(event.campaignId)) continue;
    const entry = ensureCampaign(event.campaignId);
    const amount = parseAmountOrNull(event.amount);
    if (amount === null) {
      entry.unreconciled = true;
      entry.sources.push({
        kind: "ON_CHAIN_EVENT",
        id: event.txHash,
        campaignId: event.campaignId,
        amount: null,
        reconciled: false,
        note: "On-chain event amount could not be parsed",
      });
      continue;
    }
    addValue(entry, event.valueClass, amount);
    entry.sources.push({
      kind: "ON_CHAIN_EVENT",
      id: event.txHash,
      campaignId: event.campaignId,
      amount: formatTokenAmount(amount),
      reconciled: true,
    });
  }

  for (const receipt of receipts) {
    if (receipt.sponsorId !== query.sponsorId || !inScope(receipt.campaignId)) continue;
    const entry = ensureCampaign(receipt.campaignId);
    const amount = parseAmountOrNull(receipt.amount);
    const linkedRecordMissing =
      receipt.recordId != null && !recordIds.has(receipt.recordId);
    if (amount === null || linkedRecordMissing) {
      entry.unreconciled = true;
      entry.sources.push({
        kind: "RECEIPT",
        id: receipt.id,
        campaignId: receipt.campaignId,
        amount: amount === null ? null : formatTokenAmount(amount),
        reconciled: false,
        note:
          amount === null
            ? "Receipt amount could not be parsed"
            : `Receipt references unknown record ${receipt.recordId}`,
      });
      continue;
    }
    addValue(entry, receipt.valueClass, amount);
    entry.sources.push({
      kind: "RECEIPT",
      id: receipt.id,
      campaignId: receipt.campaignId,
      amount: formatTokenAmount(amount),
      reconciled: true,
    });
  }

  const totals = { committed: 0n, matched: 0n, settled: 0n };
  let hasUnreconciledSources = false;

  const portfolioCampaigns: SponsorPortfolioCampaign[] = Array.from(campaigns.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([campaignId, entry]) => {
      totals.committed += entry.committed;
      totals.matched += entry.matched;
      totals.settled += entry.settled;
      if (entry.unreconciled) hasUnreconciledSources = true;
      const hasAnyValue = entry.committed > 0n || entry.matched > 0n || entry.settled > 0n;
      return {
        campaignId,
        committedAmount: formatTokenAmount(entry.committed),
        matchedAmount: formatTokenAmount(entry.matched),
        settledAmount: formatTokenAmount(entry.settled),
        reconciliationStatus: classifyStatus(entry.unreconciled, hasAnyValue),
        sources: entry.sources,
      };
    });

  const hasAnyValue = totals.committed > 0n || totals.matched > 0n || totals.settled > 0n;

  return {
    sponsorId: query.sponsorId,
    campaigns: portfolioCampaigns,
    totals: {
      committedAmount: formatTokenAmount(totals.committed),
      matchedAmount: formatTokenAmount(totals.matched),
      settledAmount: formatTokenAmount(totals.settled),
    },
    reconciliationStatus: classifyStatus(hasUnreconciledSources, hasAnyValue),
    hasUnreconciledSources,
  };
}
