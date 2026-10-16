/**
 * SLO and Burn-Rate Alerting Type Definitions
 */

export type CriticalFlow = 'reads' | 'submission' | 'webhooks' | 'sync';

export type AlertSeverity = 'CRITICAL' | 'WARNING' | 'ELEVATED' | 'INFO';

export interface FlowTarget {
  /** Desired availability ratio between 0 and 1 (e.g. 0.999 for 99.9%) */
  availability: number;
  /** Latency 95th percentile target in milliseconds */
  latencyP95Ms: number;
  /** Latency 99th percentile target in milliseconds */
  latencyP99Ms: number;
}

export interface OwnerInfo {
  team: string;
  handle: string;
  email: string;
  escalationPager: string;
}

export interface BurnRateThreshold {
  window: string;
  windowMs: number;
  /** Multiplier of baseline error budget consumption rate */
  burnRate: number;
  /** Percentage of 30-day error budget consumed over this window */
  budgetPercentConsumed: number;
  severity: AlertSeverity;
  notificationChannel: string;
}

export interface SLODefinition {
  flow: CriticalFlow;
  title: string;
  description: string;
  target: FlowTarget;
  owner: OwnerInfo;
  runbookUrl: string;
  burnRateThresholds: BurnRateThreshold[];
}

export interface MetricSample {
  flow: CriticalFlow;
  status: 'success' | 'error';
  durationMs: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface AggregatedMetrics {
  flow: CriticalFlow;
  windowMs: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  availabilityRate: number;
  errorRate: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  budgetRemainingPercent: number;
}

export interface BurnRateAlert {
  alertId: string;
  flow: CriticalFlow;
  severity: AlertSeverity;
  thresholdWindow: string;
  burnRate: number;
  thresholdBurnRate: number;
  errorBudgetRemainingPercent: number;
  owner: OwnerInfo;
  runbookUrl: string;
  message: string;
  remediation: string;
  triggeredAt: number;
}
