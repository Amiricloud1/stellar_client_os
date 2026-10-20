import { describe, it, expect } from 'vitest';
import {
  validateContractEvent,
  assertBackwardCompatibility,
  getEventSchema,
  registerEventSchema,
  EventSchemaDefinition,
} from '../utils/event-validator.js';

describe('Event Validator and Schema Versioning', () => {
  describe('validateContractEvent', () => {
    it('validates conforming FeeCollected event', () => {
      const schema = getEventSchema('payment-stream', 'FeeCollected', 1)!;
      expect(schema).toBeDefined();

      const validEvent = {
        topic: ['FeeCollected'],
        value: {
          streamId: 42n,
          recipient: 'GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          amount: 5000000n,
        },
      };

      const result = validateContractEvent(validEvent, schema);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.parsedPayload?.streamId).toBe(42n);
    });

    it('rejects event with missing required payload field', () => {
      const schema = getEventSchema('payment-stream', 'FeeCollected', 1)!;

      const invalidEvent = {
        topic: ['FeeCollected'],
        value: {
          streamId: 42n,
          // recipient is missing
          amount: 5000000n,
        },
      };

      const result = validateContractEvent(invalidEvent, schema);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required payload field "recipient"');
    });

    it('rejects event with mismatched topic', () => {
      const schema = getEventSchema('timelock', 'ActionProposed', 1)!;

      const invalidTopicEvent = {
        topic: [12345], // number instead of string topic name
        value: {
          admin: 'GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          actionHash: '0101010101010101010101010101010101010101010101010101010101010101',
          description: 'upgrade',
        },
      };

      const result = validateContractEvent(invalidTopicEvent, schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/Topic "eventName" expected type string/);
    });
  });

  describe('assertBackwardCompatibility', () => {
    const v1: EventSchemaDefinition = {
      contract: 'campaign-funding',
      eventName: 'CampaignCreated',
      version: 1,
      topics: [{ name: 'eventName', type: 'string', required: true }],
      payload: [
        { name: 'campaignId', type: 'bigint', required: true },
        { name: 'owner', type: 'address', required: true },
      ],
    };

    it('allows additive changes with optional fields in newer version', () => {
      const v2: EventSchemaDefinition = {
        contract: 'campaign-funding',
        eventName: 'CampaignCreated',
        version: 2,
        topics: [{ name: 'eventName', type: 'string', required: true }],
        payload: [
          { name: 'campaignId', type: 'bigint', required: true },
          { name: 'owner', type: 'address', required: true },
          { name: 'category', type: 'string', required: false }, // optional new field
        ],
      };

      expect(() => assertBackwardCompatibility(v1, v2)).not.toThrow();
    });

    it('rejects adding new required fields in newer version', () => {
      const v2Breaking: EventSchemaDefinition = {
        contract: 'campaign-funding',
        eventName: 'CampaignCreated',
        version: 2,
        topics: [{ name: 'eventName', type: 'string', required: true }],
        payload: [
          { name: 'campaignId', type: 'bigint', required: true },
          { name: 'owner', type: 'address', required: true },
          { name: 'category', type: 'string', required: true }, // breaking required field
        ],
      };

      expect(() => assertBackwardCompatibility(v1, v2Breaking)).toThrow(
        /newly added field "category" must be optional/
      );
    });

    it('rejects removal of required fields', () => {
      const v2Removed: EventSchemaDefinition = {
        contract: 'campaign-funding',
        eventName: 'CampaignCreated',
        version: 2,
        topics: [{ name: 'eventName', type: 'string', required: true }],
        payload: [
          { name: 'campaignId', type: 'bigint', required: true },
          // owner removed
        ],
      };

      expect(() => assertBackwardCompatibility(v1, v2Removed)).toThrow(
        /required field "owner" was removed/
      );
    });
  });
});
