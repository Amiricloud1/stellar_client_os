/**
 * Campaign Target History Service
 * 
 * Issue #3: Define when a target may change, preserve prior values, and explain the 
 * impact on existing donations and progress displays.
 * 
 * Tracks all campaign funding target changes, preserving history and explaining
 * the impact on:
 *   - Milestone calculations (retroactive impact)
 *   - Sponsor progress displays (goal percentage)
 *   - Sponsorship tier recalculation
 *   - Campaign payout calculations
 */

export interface TargetChangeRecord {
  /** Unix timestamp (seconds) when the change was made */
  changedAt: number;
  
  /** Previous target amount in stroops (decimal string) */
  previousTarget: string;
  
  /** New target amount in stroops (decimal string) */
  newTarget: string;
  
  /** Why was the target changed? */
  reason: "campaign_creator_request" | "admin_correction" | "milestone_adjustment" | "emergency_pause" | string;
  
  /** Who made the change? */
  changedBy: string;
  
  /** Optional explanation for sponsors */
  explanation?: string;
  
  /** What campaign state was active when this change occurred? */
  campaignState: "draft" | "active" | "paused" | "successful" | "failed";
  
  /** How many sponsors were affected by this change? */
  affectedSponsorCount: number;
  
  /** Total funding at time of change (stroops) */
  fundingAtChange: string;
}

export interface CampaignTargetImpact {
  /** The target that was active when sponsor contributed */
  targetAtContributionTime: string;
  
  /** The target that is currently active */
  currentTarget: string;
  
  /** How did the sponsor's progress bar % change? */
  progressPercentageChange: {
    previousPercent: number;
    currentPercent: number;
    change: number;
  };
  
  /** If milestone dates were linked to target, did they change? */
  milestoneImpact: {
    affectedMilestones: string[];
    explanation: string;
  };
  
  /** Did sponsor tier/receipt change due to new target? */
  tierImpact: {
    previousTier?: string;
    currentTier?: string;
    explanation?: string;
  };
}

/**
 * Calculate how a target change impacts a sponsor's contribution
 * 
 * @param sponsorContributionAmount - Amount sponsor contributed (stroops)
 * @param targetAtContribution - Target that was active when sponsor contributed
 * @param newTarget - New target after change
 * @param currentFunding - Total funding currently
 * @returns Impact analysis
 */
export function calculateTargetChangeImpactOnSponsor(
  sponsorContributionAmount: string,
  targetAtContribution: string,
  newTarget: string,
  currentFunding: string,
): CampaignTargetImpact {
  const contribution = BigInt(sponsorContributionAmount);
  const oldTarget = BigInt(targetAtContribution);
  const newTargetBig = BigInt(newTarget);
  const funding = BigInt(currentFunding);
  
  // Calculate previous progress percentage
  const previousPercent = Math.min(
    100,
    Number((funding * 100n) / oldTarget)
  );
  
  // Calculate current progress percentage
  const currentPercent = Math.min(
    100,
    Number((funding * 100n) / newTargetBig)
  );
  
  const progressChange = currentPercent - previousPercent;
  
  // Determine if this is positive or negative
  let milestoneExplanation = "";
  if (newTargetBig > oldTarget) {
    milestoneExplanation = `Target increased from ${oldTarget} to ${newTargetBig} stroops. Campaign now needs more funding to reach success. Your contribution's relative impact (%) decreased from ${previousPercent.toFixed(1)}% to ${currentPercent.toFixed(1)}%.`;
  } else {
    milestoneExplanation = `Target decreased from ${oldTarget} to ${newTargetBig} stroops. Campaign now needs less funding to reach success. Your contribution's relative impact (%) increased from ${previousPercent.toFixed(1)}% to ${currentPercent.toFixed(1)}%.`;
  }
  
  return {
    targetAtContributionTime: targetAtContribution,
    currentTarget: newTarget,
    progressPercentageChange: {
      previousPercent,
      currentPercent,
      change: progressChange,
    },
    milestoneImpact: {
      affectedMilestones: [],
      explanation: milestoneExplanation,
    },
    tierImpact: {},
  };
}

/**
 * Notify sponsors when campaign target changes
 * 
 * Creates a notification message that should be sent to all sponsors
 * explaining what changed and why it matters.
 */
export function generateTargetChangeNotification(
  campaignName: string,
  change: TargetChangeRecord,
  sponsorAddress: string,
): {
  subject: string;
  body: string;
  emphasis: "positive" | "neutral" | "warning";
} {
  const oldAmount = BigInt(change.previousTarget);
  const newAmount = BigInt(change.newTarget);
  const isIncrease = newAmount > oldAmount;
  const difference = isIncrease 
    ? newAmount - oldAmount 
    : oldAmount - newAmount;
  
  const percentChange = Number(
    ((difference * 100n) / oldAmount)
  ).toFixed(1);
  
  let subject = "";
  let emphasis: "positive" | "neutral" | "warning" = "neutral";
  
  if (isIncrease) {
    subject = `📈 Campaign "${campaignName}" goal increased by ${percentChange}%`;
    emphasis = "warning"; // Indicates campaign needs more funding now
  } else {
    subject = `🎯 Campaign "${campaignName}" goal decreased by ${percentChange}%`;
    emphasis = "positive"; // Indicates campaign is now closer to success
  }
  
  const reasonPhrase = {
    campaign_creator_request: "The campaign creator requested this change",
    admin_correction: "Our team corrected this to reflect actual project scope",
    milestone_adjustment: "The target was adjusted based on milestone completion",
    emergency_pause: "The target was temporarily adjusted due to an emergency pause",
  }[change.reason] || "The target was updated";
  
  const body = `
Hello ${sponsorAddress},

The funding target for campaign "${campaignName}" has been updated.

**Previous target:** ${(oldAmount / 1_000_000n).toString()} USDC
**New target:** ${(newAmount / 1_000_000n).toString()} USDC
**Reason:** ${reasonPhrase}

${change.explanation ? `**Details:** ${change.explanation}` : ""}

Your contribution amount remains unchanged. However, your contribution now represents 
${isIncrease 
  ? `a smaller percentage of the new goal. The campaign now needs more funding to reach success.` 
  : `a larger percentage of the goal. The campaign is now closer to reaching its target!`}

All target changes are documented on the immutable campaign ledger for transparency.
Visit ${campaignName} to see the full history.
  `.trim();
  
  return { subject, body, emphasis };
}

/**
 * Track when a campaign's target can be changed
 * 
 * Returns true if the target can still be changed in the current campaign state
 */
export function canChangeTargetInState(
  campaignState: "draft" | "active" | "paused" | "successful" | "failed" | "paid_out" | "refunded"
): boolean {
  // Targets can only be changed in draft or paused states
  // Once active and funding has started, target is locked to ensure fairness
  return campaignState === "draft" || campaignState === "paused";
}

/**
 * Validate a target change
 * 
 * @param newTarget - Proposed new target (stroops)
 * @param currentFunding - Current total funding (stroops)
 * @param campaignState - Current state of campaign
 * @returns { valid: boolean; reason?: string }
 */
export function validateTargetChange(
  newTarget: string,
  currentFunding: string,
  campaignState: string,
): { valid: boolean; reason?: string } {
  // Can only change in draft or paused states
  if (!canChangeTargetInState(campaignState as any)) {
    return {
      valid: false,
      reason: `Cannot change target in ${campaignState} state. Target can only be modified while campaign is in draft or paused status.`,
    };
  }
  
  const target = BigInt(newTarget);
  const funding = BigInt(currentFunding);
  
  // New target must be positive
  if (target <= 0n) {
    return {
      valid: false,
      reason: "New target must be greater than 0.",
    };
  }
  
  // New target should be reasonable relative to current funding
  // (not less than what's already been raised, unless special circumstances)
  if (target < funding) {
    return {
      valid: false,
      reason: `New target (${target}) cannot be less than current funding (${funding}). This would make the campaign impossible to succeed.`,
    };
  }
  
  // New target should not be unreasonably large (sanity check)
  const maxSaneTarget = funding * 10n; // Allow up to 10x current funding
  if (target > maxSaneTarget) {
    return {
      valid: false,
      reason: `New target (${target}) seems unreasonably high relative to current funding. Please verify this is intentional.`,
    };
  }
  
  return { valid: true };
}

/**
 * Record a target change in the audit log
 * 
 * This should be called whenever a campaign's target is modified
 */
export function recordTargetChange(
  campaignId: string,
  change: Omit<TargetChangeRecord, "changedAt">
): TargetChangeRecord {
  return {
    ...change,
    changedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Get audit trail message for a target change
 * 
 * Suitable for logging to the campaign-verification-audit contract
 */
export function getTargetChangeAuditMessage(
  campaignId: string,
  change: TargetChangeRecord,
): string {
  const oldAmount = Number(BigInt(change.previousTarget) / 1_000_000n);
  const newAmount = Number(BigInt(change.newTarget) / 1_000_000n);
  
  return `Campaign #${campaignId} target changed from ${oldAmount} USDC to ${newAmount} USDC. 
Reason: ${change.reason}. 
Changed by: ${change.changedBy}. 
State: ${change.campaignState}. 
Sponsors affected: ${change.affectedSponsorCount}.
${change.explanation ? `Explanation: ${change.explanation}` : ""}
Timestamp: ${new Date(change.changedAt * 1000).toISOString()}`;
}
