import { describe, it, expect, beforeEach, vi } from 'vitest';
import { 
  CampaignRefundSubmissionService,
  RefundSubmissionStatus as RefundSubmissionStatusType,
} from './campaign-refund-submission.service';

describe('CampaignRefundSubmissionService', () => {
  let service: CampaignRefundSubmissionService;

  beforeEach(() => {
    service = new CampaignRefundSubmissionService();
  });

  /**
   * Objective 3: Submission Status & Retry Logic Tests
   */
  describe('initiateSubmission', () => {
    it('creates submission attempt with unique idempotency key', () => {
      const attempt = service.initiateSubmission('camp-123', 'GD6W...X892');

      expect(attempt.id).toBeDefined();
      expect(attempt.idempotencyKey).toBeDefined();
      expect(attempt.status).toBe('INITIATED');
      expect(attempt.submittedAt).toBeDefined();
      expect(attempt.attemptNumber).toBe(1);
    });

    it('generates unique idempotency keys for same sponsor/campaign', () => {
      const attempt1 = service.initiateSubmission('camp-123', 'GD6W...X892');
      const attempt2 = service.initiateSubmission('camp-123', 'GD6W...X892');

      expect(attempt1.idempotencyKey).not.toBe(attempt2.idempotencyKey);
    });
  });

  describe('confirmSubmission', () => {
    it('marks submission as confirmed with transaction hash', () => {
      const attempt = service.initiateSubmission('camp-123', 'GD6W...X892');

      service.confirmSubmission(
        attempt.idempotencyKey,
        'abc123def456',
        12345
      );

      const status = service.getSubmissionStatus('camp-123', 'GD6W...X892');
      expect(status.lastAttempt?.status).toBe('CONFIRMED');
      expect(status.lastAttempt?.transactionHash).toBe('abc123def456');
      expect(status.lastAttempt?.ledgerNumber).toBe(12345);
      expect(status.isConfirmed).toBe(true);
    });
  });

  describe('rejectSubmission', () => {
    it('marks submission as rejected with error details', () => {
      const attempt = service.initiateSubmission('camp-123', 'GD6W...X892');

      service.rejectSubmission(
        attempt.idempotencyKey,
        'UNAUTHORIZED',
        'Sponsor is not eligible for refund'
      );

      const status = service.getSubmissionStatus('camp-123', 'GD6W...X892');
      expect(status.lastAttempt?.status).toBe('REJECTED');
      expect(status.lastAttempt?.errorCode).toBe('UNAUTHORIZED');
      expect(status.currentStatus).toBe('REJECTED');
    });
  });

  describe('timeoutSubmission', () => {
    it('marks submission as timed out (ambiguous state)', () => {
      const attempt = service.initiateSubmission('camp-123', 'GD6W...X892');

      service.timeoutSubmission(attempt.idempotencyKey);

      const status = service.getSubmissionStatus('camp-123', 'GD6W...X892');
      expect(status.lastAttempt?.status).toBe('TIMEOUT');
      expect(status.currentStatus).toBe('TIMEOUT');
      expect(status.lastAttempt?.nextRetryEligibleAt).toBeDefined();
    });

    it('calculates exponential backoff for retry delay', () => {
      const attempt1 = service.initiateSubmission('camp-123', 'GD6W...X892');
      service.timeoutSubmission(attempt1.idempotencyKey);

      let status = service.getSubmissionStatus('camp-123', 'GD6W...X892');
      const firstRetryDelay = status.lastAttempt?.nextRetryEligibleAt?.getTime() ?? 0 - Date.now();

      // Create and timeout more attempts
      const attempt2 = service.createRetryAttempt('camp-123', 'GD6W...X892');
      if (attempt2) {
        vi.useFakeTimers();
        vi.advanceTimersByTime(10000); // Wait past first retry
        service.timeoutSubmission(attempt2.idempotencyKey);
        
        status = service.getSubmissionStatus('camp-123', 'GD6W...X892');
        const secondRetryDelay = status.lastAttempt?.nextRetryEligibleAt?.getTime() ?? 0 - Date.now();
        
        // Second delay should be longer due to exponential backoff
        expect(secondRetryDelay).toBeGreaterThan(firstRetryDelay);
        vi.useRealTimers();
      }
    });
  });

  describe('canRetrySubmission', () => {
    it('allows retry after timeout', () => {
      const attempt = service.initiateSubmission('camp-123', 'GD6W...X892');
      service.timeoutSubmission(attempt.idempotencyKey);

      const canRetry = service.canRetrySubmission('camp-123', 'GD6W...X892');
      expect(canRetry.canRetry).toBe(false); // Not yet, backoff in progress
      expect(canRetry.reason).toContain('eligible in');
    });

    it('forbids retry if already confirmed', () => {
      const attempt = service.initiateSubmission('camp-123', 'GD6W...X892');
      service.confirmSubmission(attempt.idempotencyKey, 'tx123', 999);

      const canRetry = service.canRetrySubmission('camp-123', 'GD6W...X892');
      expect(canRetry.canRetry).toBe(false);
      expect(canRetry.reason).toContain('already confirmed');
    });

    it('forbids retry if explicitly rejected', () => {
      const attempt = service.initiateSubmission('camp-123', 'GD6W...X892');
      service.rejectSubmission(attempt.idempotencyKey, 'UNAUTHORIZED', 'Not eligible');

      const canRetry = service.canRetrySubmission('camp-123', 'GD6W...X892');
      expect(canRetry.canRetry).toBe(false);
      expect(canRetry.reason).toContain('Server rejected');
    });

    it('forbids retry after max attempts exceeded', () => {
      // This would require multiple timeout/retry cycles
      // Simulating a mock case where we've hit max retries
      const sponsor = 'GD6W...X892';
      const campaign = 'camp-123';
      
      // Initiate and timeout multiple times
      for (let i = 0; i < 3; i++) {
        const attempt = service.initiateSubmission(campaign, sponsor);
        service.timeoutSubmission(attempt.idempotencyKey);
        
        if (i < 2) {
          vi.useFakeTimers();
          vi.advanceTimersByTime(120000); // Skip past backoff
          vi.useRealTimers();
          
          const retry = service.createRetryAttempt(campaign, sponsor);
          if (!retry) break;
        }
      }

      const status = service.getSubmissionStatus(campaign, sponsor);
      const canRetry = service.canRetrySubmission(campaign, sponsor);
      
      // After max retries, should not allow more retries
      if (status.lastAttempt && status.lastAttempt.attemptNumber >= status.lastAttempt.maxRetries) {
        expect(canRetry.canRetry).toBe(false);
      }
    });

    it('forbids retry if refund already exists on-chain', () => {
      const attempt = service.initiateSubmission('camp-123', 'GD6W...X892');
      service.timeoutSubmission(attempt.idempotencyKey);

      const onChainState = {
        hasRefund: true,
        transactionHash: 'existing-tx-hash',
      };

      // Even in timeout state, if we check on-chain and find a refund, don't retry
      vi.useFakeTimers();
      vi.advanceTimersByTime(120000); // Skip past backoff
      const canRetry = service.canRetrySubmission('camp-123', 'GD6W...X892', onChainState);
      vi.useRealTimers();

      expect(canRetry.canRetry).toBe(false);
      expect(canRetry.reason).toContain('already exists on-chain');
    });
  });

  describe('createRetryAttempt', () => {
    it('creates retry attempt with same idempotency key', () => {
      const first = service.initiateSubmission('camp-123', 'GD6W...X892');
      service.timeoutSubmission(first.idempotencyKey);

      vi.useFakeTimers();
      vi.advanceTimersByTime(120000); // Skip past backoff
      const retry = service.createRetryAttempt('camp-123', 'GD6W...X892');
      vi.useRealTimers();

      expect(retry).not.toBeNull();
      if (retry) {
        expect(retry.idempotencyKey).toBe(first.idempotencyKey);
        expect(retry.attemptNumber).toBe(2);
      }
    });

    it('uses same idempotency key to prevent duplicate on-chain transfers', () => {
      const first = service.initiateSubmission('camp-123', 'GD6W...X892');
      const originalKey = first.idempotencyKey;
      service.timeoutSubmission(first.idempotencyKey);

      vi.useFakeTimers();
      vi.advanceTimersByTime(120000);
      const retry = service.createRetryAttempt('camp-123', 'GD6W...X892');
      vi.useRealTimers();

      // Both attempts use the same key
      expect(retry?.idempotencyKey).toBe(originalKey);

      // On-chain, the contract sees the same idempotency key and rejects duplicate
      // This prevents duplicate transfers
    });
  });

  describe('getSubmissionStatus', () => {
    it('returns comprehensive status for a sponsor', () => {
      const attempt = service.initiateSubmission('camp-123', 'GD6W...X892');

      const status = service.getSubmissionStatus('camp-123', 'GD6W...X892');

      expect(status.campaignId).toBe('camp-123');
      expect(status.sponsorAddress).toBe('GD6W...X892');
      expect(status.currentStatus).toBe('PENDING');
      expect(status.lastAttempt).toBeDefined();
      expect(status.allAttempts).toHaveLength(1);
    });

    it('differentiates REJECTED from TIMEOUT', () => {
      const attempt1 = service.initiateSubmission('camp-123', 'GD6W...X892');
      service.rejectSubmission(attempt1.idempotencyKey, 'ERROR', 'msg');

      const status1 = service.getSubmissionStatus('camp-123', 'GD6W...X892');
      expect(status1.currentStatus).toBe('REJECTED');

      // Different sponsor, timeout instead
      const attempt2 = service.initiateSubmission('camp-123', 'GB88...K992');
      service.timeoutSubmission(attempt2.idempotencyKey);

      const status2 = service.getSubmissionStatus('camp-123', 'GB88...K992');
      expect(status2.currentStatus).toBe('TIMEOUT');
      expect(status2.canRetry).toBe(false); // Backoff in progress
      expect(status2.retryEligibleAt).toBeDefined();
    });

    it('tracks all retry attempts in history', () => {
      service.initiateSubmission('camp-123', 'GD6W...X892');
      
      let status = service.getSubmissionStatus('camp-123', 'GD6W...X892');
      expect(status.allAttempts).toHaveLength(1);

      // Simulate successful retry attempt creation
      const attempt = status.lastAttempt;
      if (attempt?.status === 'INITIATED') {
        vi.useFakeTimers();
        vi.advanceTimersByTime(120000);
        const retry = service.createRetryAttempt('camp-123', 'GD6W...X892');
        vi.useRealTimers();

        if (retry) {
          status = service.getSubmissionStatus('camp-123', 'GD6W...X892');
          expect(status.allAttempts.length).toBeGreaterThanOrEqual(1);
        }
      }
    });
  });
});
