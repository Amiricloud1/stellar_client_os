import { describe, it, expect } from 'vitest';
import {
  decodeContractEvent,
  decodeAllContractEvents,
} from '../utils/event-decoders.js';

describe('Multi-Contract Family Event Decoders', () => {
  describe('PaymentStream Events', () => {
    it('decodes FeeCollected event', () => {
      const raw = {
        contractId: 'C123',
        topic: ['FeeCollected'],
        value: {
          stream_id: '1',
          recipient: 'G_RECIPIENT',
          amount: 5000000n,
          timestamp: 1700000000,
        },
      };

      const result = decodeContractEvent(raw);
      expect(result.family).toBe('payment-stream');
      expect(result.type).toBe('FeeCollected');
      if (result.type === 'FeeCollected') {
        expect(result.payload.streamId).toBe(1n);
        expect(result.payload.recipient).toBe('G_RECIPIENT');
        expect(result.payload.amount).toBe(5000000n);
      }
    });

    it('decodes StreamDeposit event', () => {
      const raw = {
        topic: ['StreamDeposit'],
        value: {
          streamId: 99,
          sender: 'G_SENDER',
          amount: '10000000',
        },
      };

      const result = decodeContractEvent(raw);
      expect(result.family).toBe('payment-stream');
      expect(result.type).toBe('StreamDeposit');
      if (result.type === 'StreamDeposit') {
        expect(result.payload.streamId).toBe(99n);
        expect(result.payload.sender).toBe('G_SENDER');
        expect(result.payload.amount).toBe(10000000n);
      }
    });

    it('decodes StreamPaused and StreamResumed', () => {
      const paused = decodeContractEvent({
        topic: ['StreamPaused'],
        value: { streamId: 10, pausedBy: 'G_ADMIN' },
      });
      expect(paused.type).toBe('StreamPaused');

      const resumed = decodeContractEvent({
        topic: ['StreamResumed'],
        value: { streamId: 10, resumedBy: 'G_ADMIN' },
      });
      expect(resumed.type).toBe('StreamResumed');
    });
  });

  describe('Distributor Events', () => {
    it('decodes DistributeBatch tuple format', () => {
      const raw = {
        topic: ['DistributeBatch'],
        value: ['C_TOKEN', 'G_SENDER', 10, 50000000n],
      };

      const result = decodeContractEvent(raw);
      expect(result.family).toBe('distributor');
      expect(result.type).toBe('DistributeBatch');
      if (result.type === 'DistributeBatch') {
        expect(result.payload.token).toBe('C_TOKEN');
        expect(result.payload.sender).toBe('G_SENDER');
        expect(result.payload.recipientCount).toBe(10);
        expect(result.payload.totalAmount).toBe(50000000n);
      }
    });
  });

  describe('Timelock Events', () => {
    it('decodes ActionProposed tuple and record formats', () => {
      const raw = {
        topic: ['ActionProposed'],
        value: ['G_ADMIN', 'hash123', 'C_TARGET', 'Upgrade contract to v2'],
      };

      const result = decodeContractEvent(raw);
      expect(result.family).toBe('timelock');
      expect(result.type).toBe('ActionProposed');
      if (result.type === 'ActionProposed') {
        expect(result.payload.admin).toBe('G_ADMIN');
        expect(result.payload.actionHash).toBe('hash123');
        expect(result.payload.target).toBe('C_TARGET');
        expect(result.payload.description).toBe('Upgrade contract to v2');
      }
    });

    it('decodes ActionExecuted and ActionCancelled', () => {
      const exec = decodeContractEvent({
        topic: ['ActionExecuted'],
        value: ['G_ADMIN', 'hash123', null],
      });
      expect(exec.type).toBe('ActionExecuted');

      const cancel = decodeContractEvent({
        topic: ['ActionCancelled'],
        value: ['G_ADMIN', 'hash123'],
      });
      expect(cancel.type).toBe('ActionCancelled');
    });
  });

  describe('Other Contract Families', () => {
    it('decodes CampaignFunding CampaignCreated', () => {
      const raw = {
        topic: ['CampaignCreated'],
        value: { campaignId: 5, owner: 'G_OWNER', goal: 1000000n },
      };
      const result = decodeContractEvent(raw);
      expect(result.family).toBe('campaign-funding');
      expect(result.type).toBe('CampaignCreated');
    });

    it('decodes CampaignDiversity DiversityScored', () => {
      const raw = {
        topic: ['DiversityScored'],
        value: { campaignId: 12, score: 85 },
      };
      const result = decodeContractEvent(raw);
      expect(result.family).toBe('campaign-diversity');
      expect(result.type).toBe('DiversityScored');
    });

    it('decodes SponsorCrowdfunding Pledged', () => {
      const raw = {
        topic: ['Pledged'],
        value: { campaignId: 3, sponsor: 'G_SPONSOR', amount: 50000n },
      };
      const result = decodeContractEvent(raw);
      expect(result.family).toBe('sponsor-crowdfunding');
      expect(result.type).toBe('Pledged');
    });
  });

  describe('Safe handling of malformed or future topics', () => {
    it('gracefully handles unknown future topic', () => {
      const raw = {
        topic: ['FutureProtocolUpgradeTriggered_v99'],
        value: { someUnknownField: true },
      };

      const result = decodeContractEvent(raw);
      expect(result.family).toBe('unknown');
      expect(result.type).toBe('Unknown');
      if (result.type === 'Unknown') {
        expect(result.payload.reason).toMatch(/Unrecognized or malformed topic/);
      }
    });

    it('gracefully handles missing topic or invalid value', () => {
      const result = decodeContractEvent({
        topic: [],
        value: null,
      });
      expect(result.family).toBe('unknown');
    });

    it('separates decoded and unhandled events in decodeAllContractEvents', () => {
      const events = [
        { topic: ['StreamDeposit'], value: { streamId: 1, sender: 'G_1', amount: 100n } },
        { topic: ['UnknownEvent'], value: {} },
      ];

      const { decoded, unhandled } = decodeAllContractEvents(events);
      expect(decoded).toHaveLength(1);
      expect(decoded[0].type).toBe('StreamDeposit');
      expect(unhandled).toHaveLength(1);
      expect(unhandled[0].family).toBe('unknown');
    });
  });
});
