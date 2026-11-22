/**
 * Safe LocalStorage Wrapper
 * 
 * Protects against QuotaExceededError or SecurityError when accessing localStorage
 * in private/incognito browsing modes or when storage is full.
 */

export const safeGetItem = (key: string): string | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
  } catch (error) {
    console.warn(`[SafeStorage] Failed to get item '${key}':`, error);
    return null;
  }
};

export const safeSetItem = (key: string, value: string): boolean => {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(key, value);
      return true;
    }
    return false;
  } catch (error) {
    console.warn(`[SafeStorage] Failed to set item '${key}':`, error);
    return false;
  }
};

export const safeRemoveItem = (key: string): boolean => {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(key);
      return true;
    }
    return false;
  } catch (error) {
    console.warn(`[SafeStorage] Failed to remove item '${key}':`, error);
    return false;
  }
};

export const isStorageAvailable = (): boolean => {
  try {
    if (typeof window === 'undefined') return false;
    const testKey = '__storage_test__';
    window.localStorage.setItem(testKey, testKey);
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
};

/**
 * Account-Scoped Storage Isolation & Wallet Disconnect Purge (Issues #164, #165, #171, #241)
 *
 * Prevents a subsequent connected account from rendering another account's cached state,
 * credentials, or draft data, while safely preserving public campaign and platform caches.
 */
export const PUBLIC_CACHE_PREFIXES = [
  'stellar_public_',
  'stellar_campaign_list',
  'stellar_metadata_',
  'stellar_global_stats'
];

export const ACCOUNT_SCOPED_PREFIX = 'stellar_account:';

export function getAccountScopedKey(accountAddress: string, key: string): string {
  const normalized = accountAddress.trim().toUpperCase();
  return `${ACCOUNT_SCOPED_PREFIX}${normalized}:${key}`;
}

export function isPublicCacheKey(key: string): boolean {
  return PUBLIC_CACHE_PREFIXES.some(prefix => key.startsWith(prefix));
}

/**
 * Purges account-scoped cache, tokens, and draft data upon wallet disconnect or account switch.
 * If accountAddress is specified, only that account's scoped items are removed.
 * If omitted, all private/user-scoped items are cleared while preserving public cache entries.
 */
export function purgeAccountScopedStorage(accountAddress?: string): void {
  if (typeof window === 'undefined') return;

  const targetPrefix = accountAddress
    ? `${ACCOUNT_SCOPED_PREFIX}${accountAddress.trim().toUpperCase()}:`
    : ACCOUNT_SCOPED_PREFIX;

  const cleanStorage = (storage: Storage) => {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key) continue;

        // Never wipe public caches
        if (isPublicCacheKey(key)) continue;

        if (key.startsWith(targetPrefix) || key.startsWith('stellar_wallet_') || key.startsWith('stellar_draft_')) {
          keysToRemove.push(key);
        }
      }

      keysToRemove.forEach(k => storage.removeItem(k));
    } catch (err) {
      console.warn('[SafeStorage] Error purging account storage:', err);
    }
  };

  cleanStorage(window.localStorage);
  cleanStorage(window.sessionStorage);
}

