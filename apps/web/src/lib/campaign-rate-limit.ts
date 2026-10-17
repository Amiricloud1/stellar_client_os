import {
  checkRouteLimit,
  buildRateLimitHeaders,
  resetRouteLimitersForTests,
  type RateLimitResult,
  type RouteClass,
} from "./rate-limit";
import type { CampaignRecord } from "@/services/campaign.service";

export type CampaignFundingTier = "basic" | "pro" | "enterprise";

export interface CampaignFundingTierConfig {
  tier: CampaignFundingTier;
  /** Funding goal in the smallest token unit. */
  maxGoalAmountExclusive: bigint | null;
  requestsPerHour: number;
}

export const CAMPAIGN_FUNDING_TIERS: Record<CampaignFundingTier, CampaignFundingTierConfig> = {
  basic: { tier: "basic", maxGoalAmountExclusive: 10_000n, requestsPerHour: 100 },
  pro: { tier: "pro", maxGoalAmountExclusive: 100_000n, requestsPerHour: 1_000 },
  enterprise: { tier: "enterprise", maxGoalAmountExclusive: null, requestsPerHour: 10_000 },
};

export function resolveCampaignFundingTier(goalAmount: string | number | bigint): CampaignFundingTierConfig {
  let amount = 0n;
  try {
    amount = BigInt(String(goalAmount));
  } catch {
    amount = 0n;
  }
  if (amount < CAMPAIGN_FUNDING_TIERS.basic.maxGoalAmountExclusive!) return CAMPAIGN_FUNDING_TIERS.basic;
  if (amount < CAMPAIGN_FUNDING_TIERS.pro.maxGoalAmountExclusive!) return CAMPAIGN_FUNDING_TIERS.pro;
  return CAMPAIGN_FUNDING_TIERS.enterprise;
}

/**
 * Campaign funding tiers are a *pricing* concept, not a rate-limit concept.
 * All campaign traffic is governed by the unified route-class policy in
 * `./rate-limit`; the tier only determines the per-campaign hourly budget
 * that is layered on top of the shared route-class limit.
 *
 * Compatibility note: this module previously created its own `RateLimiter`
 * instances keyed by tier. Those instances are gone; callers that relied on
 * `resetCampaignRateLimitersForTests` still work because the unified policy
 * owns the underlying limiter cache.
 */
const CAMPAIGN_ROUTE_CLASS: RouteClass = "authenticated";

export async function checkCampaignRateLimit(
  request: Request,
  campaign: Pick<CampaignRecord, "id" | "goalAmount" | "fundingTier">,
): Promise<
  | { allowed: true; tier: CampaignFundingTierConfig; result: RateLimitResult }
  | {
      allowed: false;
      tier: CampaignFundingTierConfig;
      result: RateLimitResult;
      headers: Record<string, string>;
    }
> {
  const tier = campaign.fundingTier
    ? CAMPAIGN_FUNDING_TIERS[campaign.fundingTier]
    : resolveCampaignFundingTier(campaign.goalAmount);

  // Delegate to the unified route-class policy. The campaign id is folded into
  // the identity key so per-campaign budgets stay atomic and isolated.
  const result = await checkRouteLimit(request, CAMPAIGN_ROUTE_CLASS, {
    scope: `campaign:${campaign.id}`,
    limitOverride: tier.requestsPerHour,
    windowMsOverride: 60 * 60 * 1_000,
  });

  if (!result.allowed) {
    return { allowed: false, tier, result, headers: buildRateLimitHeaders(result) };
  }
  return { allowed: true, tier, result };
}

export function resetCampaignRateLimitersForTests(): void {
  // The unified policy owns the limiter cache; reset it via its test hook.
  resetRouteLimitersForTests();
}
