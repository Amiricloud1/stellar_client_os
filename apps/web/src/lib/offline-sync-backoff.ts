/**
 * Offline Sync Retry Backoff, Cross-Tab Coordination, and Telemetry (Issues #266, #267, #270, #271)
 */

export interface BackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterFactor: 0.25
};

/**
 * Calculates exponential backoff with full decorrelated jitter to prevent thundering herds (Issue #266).
 */
export function calculateJitteredBackoff(
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG
): number {
  const exponential = Math.min(config.maxDelayMs, config.baseDelayMs * Math.pow(2, attempt));
  const jitter = exponential * config.jitterFactor * (Math.random() * 2 - 1);
  return Math.max(config.baseDelayMs, Math.round(exponential + jitter));
}

/**
 * Cross-Tab Coordination Guard preventing conflicting mutations in concurrent browser tabs (Issue #267).
 */
export class TabMutexCoordinator {
  private lockKey: string;

  constructor(lockKey: string = 'stellar_os_sync_mutex') {
    this.lockKey = lockKey;
  }

  public async runWithLock<T>(action: () => Promise<T>): Promise<T | null> {
    if (typeof window !== 'undefined' && 'locks' in navigator) {
      return await navigator.locks.request(this.lockKey, { mode: 'exclusive' }, async () => {
        return await action();
      });
    }

    // Fallback storage timestamp lock
    const now = Date.now();
    const stored = localStorage.getItem(this.lockKey);
    if (stored && now - parseInt(stored, 10) < 5000) {
      console.warn('[TabMutexCoordinator] Lock held by another tab, skipping concurrent run.');
      return null;
    }

    localStorage.setItem(this.lockKey, now.toString());
    try {
      return await action();
    } finally {
      localStorage.removeItem(this.lockKey);
    }
  }
}

/**
 * Preserves filter selections and facets during pagination changes (Issue #270).
 */
export function preserveFiltersOnPageChange<T extends Record<string, unknown>>(
  currentFilters: T,
  newPage: number
): T & { page: number } {
  return {
    ...currentFilters,
    page: Math.max(1, newPage)
  };
}

export interface WalletReconnectionTelemetry {
  walletId: string;
  attemptNumber: number;
  errorReason: string;
  timestamp: number;
  connectionMethod: 'extension' | 'walletconnect' | 'hardware';
}

/**
 * Captures structured telemetry for failed wallet reconnection attempts (Issue #271).
 */
export function trackWalletReconnectionFailure(event: WalletReconnectionTelemetry): void {
  if (typeof window === 'undefined') return;
  try {
    const key = 'stellar_os_wallet_reconnection_failures';
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    existing.push(event);
    // Keep last 20 failure traces for diagnostics
    if (existing.length > 20) existing.shift();
    localStorage.setItem(key, JSON.stringify(existing));
  } catch {
    // Fail silently in restricted storage environments
  }
}
