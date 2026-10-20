import {
  CriticalFlow,
  MetricSample,
  AggregatedMetrics,
  BurnRateAlert,
  SLODefinition,
} from './slo.types';
import { SLO_DEFINITIONS, THIRTY_DAYS_MS } from './slo-definitions';

/**
 * Computes a given percentile (e.g. 95 for p95) from sorted numeric values.
 */
function calculatePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

export class SLOTracker {
  private static instance: SLOTracker;
  private samples: MetricSample[] = [];
  private readonly maxSamples = 50000;

  static getInstance(): SLOTracker {
    if (!SLOTracker.instance) {
      SLOTracker.instance = new SLOTracker();
    }
    return SLOTracker.instance;
  }

  recordEvent(
    flow: CriticalFlow,
    status: 'success' | 'error',
    durationMs: number,
    timestamp: number = Date.now(),
    metadata?: Record<string, unknown>
  ): void {
    if (this.samples.length >= this.maxSamples) {
      this.samples.shift();
    }
    this.samples.push({
      flow,
      status,
      durationMs,
      timestamp,
      metadata,
    });
  }

  getMetrics(
    flow: CriticalFlow,
    windowMs: number,
    now: number = Date.now()
  ): AggregatedMetrics {
    const cutoff = now - windowMs;
    const windowSamples = this.samples.filter(
      (s) => s.flow === flow && s.timestamp >= cutoff && s.timestamp <= now
    );

    const totalRequests = windowSamples.length;
    if (totalRequests === 0) {
      return {
        flow,
        windowMs,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        availabilityRate: 1.0,
        errorRate: 0.0,
        p50Ms: 0,
        p90Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        budgetRemainingPercent: 100,
      };
    }

    const successfulRequests = windowSamples.filter((s) => s.status === 'success').length;
    const failedRequests = totalRequests - successfulRequests;
    const availabilityRate = Number((successfulRequests / totalRequests).toFixed(5));
    const errorRate = Number((failedRequests / totalRequests).toFixed(5));

    const durations = windowSamples.map((s) => s.durationMs).sort((a, b) => a - b);
    const p50Ms = Number(calculatePercentile(durations, 50).toFixed(2));
    const p90Ms = Number(calculatePercentile(durations, 90).toFixed(2));
    const p95Ms = Number(calculatePercentile(durations, 95).toFixed(2));
    const p99Ms = Number(calculatePercentile(durations, 99).toFixed(2));

    const sloDef = SLO_DEFINITIONS[flow];
    const allowedErrorBudget = 1 - sloDef.target.availability;
    const errorBudgetConsumedRatio = errorRate / (allowedErrorBudget || 0.0001);
    const budgetRemainingPercent = Math.max(0, Number(((1 - errorBudgetConsumedRatio) * 100).toFixed(2)));

    return {
      flow,
      windowMs,
      totalRequests,
      successfulRequests,
      failedRequests,
      availabilityRate,
      errorRate,
      p50Ms,
      p90Ms,
      p95Ms,
      p99Ms,
      budgetRemainingPercent,
    };
  }

  calculateBurnRate(
    flow: CriticalFlow,
    windowMs: number,
    now: number = Date.now()
  ): number {
    const metrics = this.getMetrics(flow, windowMs, now);
    if (metrics.totalRequests === 0) return 0;

    const sloDef = SLO_DEFINITIONS[flow];
    const allowedErrorBudget = 1 - sloDef.target.availability;

    // Burn rate = actual error rate / allowed error rate budget
    const burnRate = metrics.errorRate / (allowedErrorBudget || 0.001);
    return Number(burnRate.toFixed(2));
  }

  checkAlerts(now: number = Date.now()): BurnRateAlert[] {
    const alerts: BurnRateAlert[] = [];
    const flows: CriticalFlow[] = ['reads', 'submission', 'webhooks', 'sync'];

    for (const flow of flows) {
      const sloDef = SLO_DEFINITIONS[flow];

      for (const threshold of sloDef.burnRateThresholds) {
        const burnRate = this.calculateBurnRate(flow, threshold.windowMs, now);
        const metrics = this.getMetrics(flow, threshold.windowMs, now);

        // Require minimum sample volume (at least 5 requests) to prevent false positives on low traffic
        if (metrics.totalRequests >= 5 && burnRate >= threshold.burnRate) {
          const alertId = `alert_${flow}_${threshold.window}_${now}`;
          alerts.push({
            alertId,
            flow,
            severity: threshold.severity,
            thresholdWindow: threshold.window,
            burnRate,
            thresholdBurnRate: threshold.burnRate,
            errorBudgetRemainingPercent: metrics.budgetRemainingPercent,
            owner: sloDef.owner,
            runbookUrl: sloDef.runbookUrl,
            message: `Critical Flow [${flow.toUpperCase()}] burning error budget at ${burnRate}x (threshold: ${threshold.burnRate}x) over ${threshold.window} window.`,
            remediation: `Consult runbook at ${sloDef.runbookUrl} and escalate to ${sloDef.owner.handle} (${sloDef.owner.escalationPager}).`,
            triggeredAt: now,
          });
        }
      }
    }

    return alerts;
  }

  exportPrometheusMetrics(now: number = Date.now()): string {
    const lines: string[] = [
      '# HELP fundable_slo_availability_ratio Current measured availability ratio for critical flow',
      '# TYPE fundable_slo_availability_ratio gauge',
      '# HELP fundable_slo_burn_rate Error budget burn rate multiplier',
      '# TYPE fundable_slo_burn_rate gauge',
      '# HELP fundable_slo_latency_p95_ms 95th percentile latency in milliseconds',
      '# TYPE fundable_slo_latency_p95_ms gauge',
    ];

    const flows: CriticalFlow[] = ['reads', 'submission', 'webhooks', 'sync'];
    const windowMs = 60 * 60 * 1000; // 1 hour

    for (const flow of flows) {
      const metrics = this.getMetrics(flow, windowMs, now);
      const burnRate = this.calculateBurnRate(flow, windowMs, now);

      lines.push(`fundable_slo_availability_ratio{flow="${flow}"} ${metrics.availabilityRate}`);
      lines.push(`fundable_slo_burn_rate{flow="${flow}",window="1h"} ${burnRate}`);
      lines.push(`fundable_slo_latency_p95_ms{flow="${flow}"} ${metrics.p95Ms}`);
    }

    return lines.join('\n');
  }

  clear(): void {
    this.samples = [];
  }
}
