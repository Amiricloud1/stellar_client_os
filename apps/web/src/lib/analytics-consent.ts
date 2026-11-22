/**
 * Platform Analytics Consent and Pipeline Gating (Issues #250, #272, #273, #274)
 *
 * Enforces cross-platform privacy defaults, granular category consents, and
 * instantaneous consent revocation across web and mobile event pipelines.
 */

export type ConsentCategory = 'essential' | 'telemetry' | 'performance' | 'marketing';

export interface ConsentRecord {
  granted: boolean;
  timestamp: number;
  source: 'web' | 'mobile';
  revokedAt?: number;
}

export type PlatformConsentState = Record<ConsentCategory, ConsentRecord>;

export interface AnalyticsEventPayload {
  eventName: string;
  category: ConsentCategory;
  platform: 'web' | 'mobile';
  timestamp: number;
  properties?: Record<string, unknown>;
}

const DEFAULT_CONSENT: PlatformConsentState = {
  essential: { granted: true, timestamp: Date.now(), source: 'web' },
  telemetry: { granted: false, timestamp: Date.now(), source: 'web' },
  performance: { granted: false, timestamp: Date.now(), source: 'web' },
  marketing: { granted: false, timestamp: Date.now(), source: 'web' }
};

class AnalyticsConsentManager {
  private consentState: PlatformConsentState;
  private pendingQueue: AnalyticsEventPayload[] = [];
  private readonly storageKey = 'stellar_os_consent_settings_v1';

  constructor() {
    this.consentState = this.loadConsent();
  }

  private loadConsent(): PlatformConsentState {
    if (typeof window === 'undefined' || !window.localStorage) {
      return { ...DEFAULT_CONSENT };
    }

    try {
      const stored = window.localStorage.getItem(this.storageKey);
      if (stored) {
        return { ...DEFAULT_CONSENT, ...JSON.parse(stored) };
      }
    } catch {
      // Fallback to default safe state
    }

    return { ...DEFAULT_CONSENT };
  }

  private saveConsent(): void {
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(this.storageKey, JSON.stringify(this.consentState));
      } catch {
        // LocalStorage quota or access error handled safely
      }
    }
  }

  /**
   * Checks if an event category currently has granted consent.
   * Essential events are always allowed for platform integrity.
   */
  public hasConsent(category: ConsentCategory): boolean {
    if (category === 'essential') return true;
    const record = this.consentState[category];
    return record?.granted === true && !record.revokedAt;
  }

  /**
   * Updates consent status for specific categories.
   */
  public updateConsent(
    updates: Partial<Record<ConsentCategory, boolean>>,
    source: 'web' | 'mobile' = 'web'
  ): void {
    const now = Date.now();
    for (const [cat, granted] of Object.entries(updates) as [ConsentCategory, boolean][]) {
      if (cat === 'essential') continue; // Essential remains immutable

      const prev = this.consentState[cat];
      this.consentState[cat] = {
        granted,
        timestamp: now,
        source,
        revokedAt: granted ? undefined : now
      };

      if (!granted) {
        // Immediate pipeline revocation: purge all queued events matching this category
        this.pendingQueue = this.pendingQueue.filter(evt => evt.category !== cat);
      }
    }

    this.saveConsent();
  }

  /**
   * Revoke all non-essential consent immediately across pipelines.
   */
  public revokeAll(source: 'web' | 'mobile' = 'web'): void {
    const now = Date.now();
    this.consentState = {
      essential: { granted: true, timestamp: now, source },
      telemetry: { granted: false, timestamp: now, source, revokedAt: now },
      performance: { granted: false, timestamp: now, source, revokedAt: now },
      marketing: { granted: false, timestamp: now, source, revokedAt: now }
    };
    this.pendingQueue = [];
    this.saveConsent();
  }

  /**
   * Intercepts an event before dispatch.
   * Returns true if event is allowed to dispatch, false if dropped or gated.
   */
  public gateEvent(event: AnalyticsEventPayload): boolean {
    if (!this.hasConsent(event.category)) {
      return false;
    }
    return true;
  }

  /**
   * Returns the current consent state snapshot.
   */
  public getSnapshot(): PlatformConsentState {
    return { ...this.consentState };
  }
}

export const analyticsConsentManager = new AnalyticsConsentManager();
