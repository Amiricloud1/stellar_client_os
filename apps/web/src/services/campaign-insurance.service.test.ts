import { describe, it, expect } from 'vitest';
import { 
  CampaignInsuranceService, 
  RefundEligibility 
} from './campaign-insurance.service';

describe('CampaignInsuranceService', () => {
  describe('getCoverageStatus', () => {
    it('computes coverage status and 1% funding accurately', () => {
      const createdAt = new Date('2026-01-01T00:00:00Z');
      const now = new Date('2026-06-01T00:00:00Z');
      const status = CampaignInsuranceService.getCoverageStatus(851, BigInt(100000), createdAt, now);

      expect(status.insuranceFundedAmount).toBe(BigInt(1000));
      expect(status.isCovered).toBe(true);
      expect(status.daysRemaining).toBeGreaterThan(500);
    });

    it('marks coverage as expired after 2 years', () => {
      const createdAt = new Date('2024-01-01T00:00:00Z');
      const now = new Date('2026-02-01T00:00:00Z');
      const status = CampaignInsuranceService.getCoverageStatus(851, BigInt(100000), createdAt, now);

      expect(status.isCovered).toBe(false);
      expect(status.daysRemaining).toBe(0);
    });
  });

  /**
   * Objective 1: Refund Eligibility Tests
   */
  describe('evaluateRefundEligibility', () => {
    it('marks sponsor as eligible for failed campaign with contribution', () => {
      const eligibility = CampaignInsuranceService.evaluateRefundEligibility(
        true,  // campaignFailed
        BigInt(1000),  // sponsorContribution
        false  // alreadyRefunded
      );

      expect(eligibility.isEligible).toBe(true);
      expect(eligibility.reason).toContain('eligible for a full refund');
    });

    it('denies refund for successful campaign', () => {
      const eligibility = CampaignInsuranceService.evaluateRefundEligibility(
        false,  // campaignFailed
        BigInt(1000),  // sponsorContribution
        false  // alreadyRefunded
      );

      expect(eligibility.isEligible).toBe(false);
      expect(eligibility.failureReason).toBe('CAMPAIGN_NOT_FAILED');
    });

    it('denies refund if already refunded', () => {
      const eligibility = CampaignInsuranceService.evaluateRefundEligibility(
        true,  // campaignFailed
        BigInt(1000),  // sponsorContribution
        true  // alreadyRefunded
      );

      expect(eligibility.isEligible).toBe(false);
      expect(eligibility.failureReason).toBe('ALREADY_REFUNDED');
    });

    it('denies refund for zero contribution', () => {
      const eligibility = CampaignInsuranceService.evaluateRefundEligibility(
        true,  // campaignFailed
        BigInt(0),  // sponsorContribution
        false  // alreadyRefunded
      );

      expect(eligibility.isEligible).toBe(false);
      expect(eligibility.failureReason).toBe('NO_CONTRIBUTION');
    });
  });

  /**
   * Objective 1: Refund State Building Tests
   */
  describe('buildRefundState', () => {
    it('builds complete refund state for eligible sponsor', () => {
      const refundState = CampaignInsuranceService.buildRefundState(
        'GD6W...X892',
        851,
        BigInt(5000),
        true,  // campaignFailed
        false  // alreadyRefunded
      );

      expect(refundState.sponsorAddress).toBe('GD6W...X892');
      expect(refundState.campaignId).toBe(851);
      expect(refundState.contribution).toBe(BigInt(5000));
      expect(refundState.eligibility.isEligible).toBe(true);
      expect(refundState.submissionState).toBe('NOT_REQUESTED');
      expect(refundState.confirmedTransaction).toBeUndefined();
    });

    it('includes confirmed transaction when provided', () => {
      const confirmedTx = {
        transactionHash: 'abc123def456',
        ledger: 12345,
        timestamp: new Date('2026-01-15T10:30:00Z'),
        amount: BigInt(5000),
        status: 'success' as const,
      };

      const refundState = CampaignInsuranceService.buildRefundState(
        'GD6W...X892',
        851,
        BigInt(5000),
        true,
        false,
        'CONFIRMED',
        confirmedTx
      );

      expect(refundState.confirmedTransaction).toEqual(confirmedTx);
      expect(refundState.submissionState).toBe('CONFIRMED');
    });

    it('distinguishes NOT_REQUESTED from PENDING states', () => {
      const notRequested = CampaignInsuranceService.buildRefundState(
        'GD6W...X892',
        851,
        BigInt(5000),
        true,
        false,
        'NOT_REQUESTED'
      );

      const pending = CampaignInsuranceService.buildRefundState(
        'GB88...K992',
        851,
        BigInt(5000),
        true,
        false,
        'PENDING'
      );

      expect(notRequested.submissionState).toBe('NOT_REQUESTED');
      expect(pending.submissionState).toBe('PENDING');
    });
  });
});
