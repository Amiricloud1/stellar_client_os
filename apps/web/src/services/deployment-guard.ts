/**
 * Deployment Guard — Issue #3: Prevent deployment while offline
 * 
 * Before any financial or deployment action, verify that:
 * 1. The user is currently online
 * 2. For draft-based deployments, the user has explicitly confirmed online status
 * 
 * This prevents accidental deployments while offline, which could lead to
 * data loss or inconsistent state when the connection is restored.
 */

/**
 * Guard type for deployment actions. Ensures that critical operations
 * cannot proceed without explicit online confirmation.
 */
export interface DeploymentGuard {
  /** Whether the browser is currently online. */
  isOnline: boolean;
  /**
   * Unix timestamp when the user last confirmed they are online.
   * Must be recent (within last 30 seconds) to allow deployment.
   */
  onlineConfirmedAt?: number;
  /**
   * Whether online confirmation is required before deployment.
   * Set to true for draft-based campaigns or significant financial actions.
   */
  requiresOnlineConfirmation: boolean;
}

const ONLINE_CONFIRMATION_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Check if a deployment is allowed to proceed.
 * 
 * Returns { allowed: true } if:
 * - User is online (isOnline === true)
 * - AND either:
 *   - requiresOnlineConfirmation === false, OR
 *   - onlineConfirmedAt is recent (within 30 seconds)
 * 
 * Otherwise returns { allowed: false, reason: string }
 */
export function checkDeploymentGuard(
  guard: DeploymentGuard,
): { allowed: boolean; reason?: string } {
  if (!guard.isOnline) {
    return {
      allowed: false,
      reason: "You are currently offline. Please wait for your connection to be restored.",
    };
  }

  if (!guard.requiresOnlineConfirmation) {
    // No confirmation needed; online is sufficient
    return { allowed: true };
  }

  // Confirmation is required
  if (!guard.onlineConfirmedAt) {
    return {
      allowed: false,
      reason:
        "Please confirm that you are online before deploying. " +
        "This prevents accidental deployments while your connection is unstable.",
    };
  }

  // Check if confirmation is still fresh
  const now = Date.now();
  if (now - guard.onlineConfirmedAt > ONLINE_CONFIRMATION_TIMEOUT_MS) {
    return {
      allowed: false,
      reason:
        "Your online confirmation has expired (more than 30 seconds ago). " +
        "Please confirm again before deploying.",
    };
  }

  return { allowed: true };
}

/**
 * Helper to display a deployment confirmation dialog to the user.
 * This should be called before deploying a draft or financial transaction.
 * 
 * Usage:
 * ```typescript
 * const confirmed = await requestDeploymentConfirmation(
 *   "campaign",
 *   "Create Campaign",
 *   campaignData
 * );
 * if (!confirmed) return; // User cancelled
 * ```
 */
export interface DeploymentConfirmationParams {
  actionType: string; // e.g. "campaign", "stream", "payment"
  actionLabel: string; // e.g. "Create Campaign"
  actionData?: unknown; // Summary of what will be deployed
}

export async function requestDeploymentConfirmation(
  params: DeploymentConfirmationParams,
): Promise<boolean> {
  // In a real app, this would be a modal dialog
  // For now, we return a placeholder that can be overridden by the app
  const message =
    `Confirm deployment of ${params.actionLabel}\n\n` +
    `Action: ${params.actionType}\n` +
    `Please ensure you are online and ready to submit this transaction.`;

  // This will be replaced with an actual confirmation dialog in the UI layer
  return typeof window !== "undefined" && window.confirm(message);
}

/**
 * Mark that the user has confirmed they are online and ready for deployment.
 * This should be called after the user clicks "I'm ready to deploy" in the UI.
 */
export function recordOnlineConfirmation(): number {
  return Date.now();
}
