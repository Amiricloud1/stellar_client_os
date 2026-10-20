import { describe, it, expect, beforeEach } from 'vitest';
import { SLOTracker } from './slo-tracker';
import { SLO_DEFINITIONS } from './slo-definitions';
import { CriticalFlow } from './slo.types';

describe('SLO and Alert Thresholds Evaluation Engine', () => {
  let tracker: SLOTracker;
  const baseNow = 1770000000000;

  beforeEach(() => {
    tracker = SLOTracker.getInstance();
    tracker.clear();
  });

  describe('SLO Definitions & Ownership Registry', () => {
    const requiredFlows: CriticalFlow[] = ['reads', 'submission', 'webhooks', 'sync'];

    it.each(requiredFlows)('defines measured targets, owners, and runbooks for flow: %s', (flow) => {
      const def = SLO_DEFINITIONS[flow];

      expect(def).toBeDefined();
      expect(def.target.availability).toBeGreaterThanOrEqual(0.99);
      expect(def.target.latencyP95Ms).toBeGreaterThan(0);
      expect(def.target.latencyP99Ms).toBeGreaterThan(def.target.latencyP95Ms);

      // Verify Owner metadata
      expect(def.owner.team).toBeTruthy();
      expect(def.owner.handle).toMatch(/^@fundable\//);
      expect(def.owner.email).toContain('@fundable.org');
      expect(def.owner.escalationPager).toBeTruthy();

      // Verify Runbook deep link
      expect(def.runbookUrl).toContain(`docs/runbooks/slo-burn-rate.md#${flow}-flow-degradation`);

      // Verify Multi-window burn rate thresholds (1h, 6h, 24h)
      expect(def.burnRateThresholds).toHaveLength(3);
      expect(def.burnRateThresholds.some((t) => t.severity === 'CRITICAL' && t.burnRate === 14.4)).toBe(true);
      expect(def.burnRateThresholds.some((t) => t.severity === 'WARNING' && t.burnRate === 6.0)).toBe(true);
      expect(def.burnRateThresholds.some((t) => t.severity === 'ELEVATED' && t.burnRate === 2.0)).toBe(true);
    });
  });

  describe('Metric Aggregation & Percentile Latencies', () => {
    it('returns 100% availability and zero error rate when no errors occur', () => {
      for (let i = 0; i < 20; i++) {
        tracker.recordEvent('reads', 'success', 50 + i * 2, baseNow);
      }

      const metrics = tracker.getMetrics('reads', 3600000, baseNow);

      expect(metrics.totalRequests).toBe(20);
      expect(metrics.successfulRequests).toBe(20);
      expect(metrics.failedRequests).toBe(0);
      expect(metrics.availabilityRate).toBe(1.0);
      expect(metrics.errorRate).toBe(0.0);
      expect(metrics.budgetRemainingPercent).toBe(100);
      expect(metrics.p95Ms).toBeGreaterThanOrEqual(80);
    });

    it('calculates latency percentiles accurately across distributed samples', () => {
      // 100 samples with durations 1ms to 100ms
      for (let i = 1; i <= 100; i++) {
        tracker.recordEvent('sync', 'success', i, baseNow);
      }

      const metrics = tracker.getMetrics('sync', 3600000, baseNow);

      expect(metrics.p50Ms).toBe(50);
      expect(metrics.p90Ms).toBe(90);
      expect(metrics.p95Ms).toBe(95);
      expect(metrics.p99Ms).toBe(99);
    });
  });

  describe('Burn-Rate Calculation & Alerting', () => {
    it('computes error budget consumption and burn rate multiplier', () => {
      // For webhooks, availability target is 99.9% (error budget: 0.1% or 0.001)
      // If we record 100 requests with 1 failure -> error rate is 1% (0.01)
      // Burn rate = 0.01 / 0.001 = 10x burn rate
      for (let i = 0; i < 99; i++) {
        tracker.recordEvent('webhooks', 'success', 100, baseNow);
      }
      tracker.recordEvent('webhooks', 'error', 200, baseNow);

      const burnRate = tracker.calculateBurnRate('webhooks', 3600000, baseNow);
      expect(burnRate).toBe(10);
    });

    it('triggers CRITICAL alert when 1-hour fast burn rate exceeds 14.4x', () => {
      // Submission SLO availability target: 99.5% (error budget: 0.5% or 0.005)
      // 14.4x burn rate = error rate >= 14.4 * 0.005 = 7.2% error rate
      // 100 requests with 10 failures = 10% error rate -> burn rate 20x > 14.4x
      for (let i = 0; i < 90; i++) {
        tracker.recordEvent('submission', 'success', 250, baseNow);
      }
      for (let i = 0; i < 10; i++) {
        tracker.recordEvent('submission', 'error', 1500, baseNow);
      }

      const alerts = tracker.checkAlerts(baseNow);
      const submissionAlert = alerts.find((a) => a.flow === 'submission' && a.severity === 'CRITICAL');

      expect(submissionAlert).toBeDefined();
      expect(submissionAlert?.burnRate).toBeGreaterThanOrEqual(14.4);
      expect(submissionAlert?.owner.team).toBe('Blockchain Operations Team');
      expect(submissionAlert?.runbookUrl).toContain('docs/runbooks/slo-burn-rate.md#submission-flow-degradation');
      expect(submissionAlert?.remediation).toContain('@fundable/blockchain-ops');
    });

    it('suppresses false positive alerts when sample volume is insufficient (< 5 requests)', () => {
      // 2 requests, 1 failed (50% error rate), but volume is too low to trigger alarm
      tracker.recordEvent('reads', 'success', 50, baseNow);
      tracker.recordEvent('reads', 'error', 100, baseNow);

      const alerts = tracker.checkAlerts(baseNow);
      expect(alerts).toHaveLength(0);
    });
  });

  describe('Prometheus Metrics Exposition', () => {
    it('exports OpenMetrics / Prometheus compatible gauges for all flows', () => {
      tracker.recordEvent('reads', 'success', 80, baseNow);
      tracker.recordEvent('submission', 'success', 300, baseNow);

      const metricsText = tracker.exportPrometheusMetrics(baseNow);

      expect(metricsText).toContain('fundable_slo_availability_ratio{flow="reads"}');
      expect(metricsText).toContain('fundable_slo_burn_rate{flow="reads",window="1h"}');
      expect(metricsText).toContain('fundable_slo_latency_p95_ms{flow="reads"}');
      expect(metricsText).toContain('fundable_slo_availability_ratio{flow="submission"}');
    });
  });
});
