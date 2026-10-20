import { CriticalFlow, SLODefinition } from './slo.types';

export const ONE_HOUR_MS = 60 * 60 * 1000;
export const SIX_HOURS_MS = 6 * ONE_HOUR_MS;
export const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;
export const THIRTY_DAYS_MS = 30 * TWENTY_FOUR_HOURS_MS;

/**
 * Standard Multi-Window Multi-Burn-Rate Alerting Rules (Google SRE Standard)
 * - 1h window: 14.4x burn rate -> consumes 2% of 30-day budget in 1 hour -> CRITICAL (pager)
 * - 6h window: 6.0x burn rate -> consumes 5% of 30-day budget in 6 hours -> WARNING (urgent ticket)
 * - 24h window: 2.0x burn rate -> consumes 10% of 30-day budget in 24 hours -> ELEVATED (daily review)
 */
export const DEFAULT_BURN_RATE_THRESHOLDS = [
  {
    window: '1h',
    windowMs: ONE_HOUR_MS,
    burnRate: 14.4,
    budgetPercentConsumed: 2.0,
    severity: 'CRITICAL' as const,
    notificationChannel: 'pagerduty-urgent',
  },
  {
    window: '6h',
    windowMs: SIX_HOURS_MS,
    burnRate: 6.0,
    budgetPercentConsumed: 5.0,
    severity: 'WARNING' as const,
    notificationChannel: 'slack-incidents',
  },
  {
    window: '24h',
    windowMs: TWENTY_FOUR_HOURS_MS,
    burnRate: 2.0,
    budgetPercentConsumed: 10.0,
    severity: 'ELEVATED' as const,
    notificationChannel: 'daily-digest-email',
  },
];

export const SLO_DEFINITIONS: Record<CriticalFlow, SLODefinition> = {
  reads: {
    flow: 'reads',
    title: 'Campaign & Ledger Query Flow',
    description: 'Campaign discovery, progress queries, leaderboard lookups, and Horizon account reads.',
    target: {
      availability: 0.999, // 99.9% availability (error budget: 0.1%)
      latencyP95Ms: 250,
      latencyP99Ms: 500,
    },
    owner: {
      team: 'Core Platform Team',
      handle: '@fundable/platform-core',
      email: 'platform-eng@fundable.org',
      escalationPager: 'pager-platform-core',
    },
    runbookUrl: 'docs/runbooks/slo-burn-rate.md#reads-flow-degradation',
    burnRateThresholds: DEFAULT_BURN_RATE_THRESHOLDS,
  },

  submission: {
    flow: 'submission',
    title: 'Payment Stream & Contract Submission Flow',
    description: 'Stream creation, withdrawal, token distribution, donation submission, and contract execution.',
    target: {
      availability: 0.995, // 99.5% availability (error budget: 0.5%)
      latencyP95Ms: 1500,
      latencyP99Ms: 3000,
    },
    owner: {
      team: 'Blockchain Operations Team',
      handle: '@fundable/blockchain-ops',
      email: 'blockchain-ops@fundable.org',
      escalationPager: 'pager-blockchain-ops',
    },
    runbookUrl: 'docs/runbooks/slo-burn-rate.md#submission-flow-degradation',
    burnRateThresholds: DEFAULT_BURN_RATE_THRESHOLDS,
  },

  webhooks: {
    flow: 'webhooks',
    title: 'Partner & Integration Webhook Delivery Flow',
    description: 'Signed HMAC event notifications to subscriber endpoints with exponential backoff and DLQ routing.',
    target: {
      availability: 0.999, // 99.9% delivery within SLA retry window (error budget: 0.1%)
      latencyP95Ms: 1000,
      latencyP99Ms: 2500,
    },
    owner: {
      team: 'Integrations & Ecosystem Team',
      handle: '@fundable/integrations',
      email: 'integrations-team@fundable.org',
      escalationPager: 'pager-integrations',
    },
    runbookUrl: 'docs/runbooks/slo-burn-rate.md#webhooks-flow-degradation',
    burnRateThresholds: DEFAULT_BURN_RATE_THRESHOLDS,
  },

  sync: {
    flow: 'sync',
    title: 'Horizon & Soroban Ledger Synchronization Flow',
    description: 'Continuous indexing of Stellar ledgers, contract events, cache invalidation, and state freshness.',
    target: {
      availability: 0.999, // 99.9% freshness (sync lag <= 2 ledgers / 10s)
      latencyP95Ms: 300,
      latencyP99Ms: 600,
    },
    owner: {
      team: 'Node & Sync Operations Team',
      handle: '@fundable/node-sync',
      email: 'node-sync@fundable.org',
      escalationPager: 'pager-node-sync',
    },
    runbookUrl: 'docs/runbooks/slo-burn-rate.md#sync-flow-degradation',
    burnRateThresholds: DEFAULT_BURN_RATE_THRESHOLDS,
  },
};
