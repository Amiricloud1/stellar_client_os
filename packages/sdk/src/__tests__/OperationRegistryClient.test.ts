/**
 * Tests for OperationRegistryClient
 * 
 * Verifies:
 * - Operation ID computation is deterministic
 * - Cross-contract linking is collision-proof
 * - Event chain verification
 * - Operation summary generation
 */

import {
  computeOperationId,
  verifyOperationChain,
  summarizeOperations,
  createMockOperationRegistryContract,
  decodeOperationMetadata,
  decodeEventRecord,
  OperationChain,
  EventRecord,
  OperationLinkedEvent,
} from '../OperationRegistryClient';
import { describe, it, expect, beforeEach } from 'vitest';

describe('OperationRegistryClient', () => {
  describe('computeOperationId', () => {
    const testAddr = 'CBWD2N7N7TYFEPZC7CTCDW3IURXFEZQSCHLXABSWN7V2TQNGWW3GCJMB';
    const testTxHash = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const testLedgerSeq = 12345;
    const testOpIndex = 0;

    it('should compute deterministic operation IDs', () => {
      const id1 = computeOperationId(testAddr, testTxHash, testLedgerSeq, testOpIndex);
      const id2 = computeOperationId(testAddr, testTxHash, testLedgerSeq, testOpIndex);
      const id3 = computeOperationId(testAddr, testTxHash, testLedgerSeq, testOpIndex);

      expect(id1).toBe(id2);
      expect(id2).toBe(id3);
      expect(typeof id1).toBe('bigint');
    });

    it('should produce different IDs for different addresses', () => {
      const addr1 = 'CBWD2N7N7TYFEPZC7CTCDW3IURXFEZQSCHLXABSWN7V2TQNGWW3GCJMB';
      const addr2 = 'CADWM7CG2GGQQ3BJKWMF4GCDVHGUKZCVVVL23JKQR6TT2JXULHGVBM6';

      const id1 = computeOperationId(addr1, testTxHash, testLedgerSeq, testOpIndex);
      const id2 = computeOperationId(addr2, testTxHash, testLedgerSeq, testOpIndex);

      expect(id1).not.toBe(id2);
    });

    it('should produce different IDs for different tx hashes', () => {
      const txHash1 = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
      const txHash2 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

      const id1 = computeOperationId(testAddr, txHash1, testLedgerSeq, testOpIndex);
      const id2 = computeOperationId(testAddr, txHash2, testLedgerSeq, testOpIndex);

      expect(id1).not.toBe(id2);
    });

    it('should produce different IDs for different ledger sequences', () => {
      const id1 = computeOperationId(testAddr, testTxHash, 12345, testOpIndex);
      const id2 = computeOperationId(testAddr, testTxHash, 12346, testOpIndex);
      const id3 = computeOperationId(testAddr, testTxHash, 99999, testOpIndex);

      expect(id1).not.toBe(id2);
      expect(id1).not.toBe(id3);
      expect(id2).not.toBe(id3);
    });

    it('should produce different IDs for different operation indices', () => {
      const id0 = computeOperationId(testAddr, testTxHash, testLedgerSeq, 0);
      const id1 = computeOperationId(testAddr, testTxHash, testLedgerSeq, 1);
      const id255 = computeOperationId(testAddr, testTxHash, testLedgerSeq, 255);

      expect(id0).not.toBe(id1);
      expect(id0).not.toBe(id255);
      expect(id1).not.toBe(id255);
    });

    it('should accept Buffer for tx hash', () => {
      const txHashBuffer = Buffer.from(testTxHash, 'hex');
      const idFromHex = computeOperationId(testAddr, testTxHash, testLedgerSeq, testOpIndex);
      const idFromBuffer = computeOperationId(testAddr, txHashBuffer, testLedgerSeq, testOpIndex);

      expect(idFromHex).toBe(idFromBuffer);
    });

    it('should produce unique IDs for multiple operations in same transaction', () => {
      const ids = new Set<bigint>();

      for (let i = 0; i < 100; i++) {
        const id = computeOperationId(testAddr, testTxHash, testLedgerSeq, i);
        expect(ids.has(id)).toBe(false); // No duplicates
        ids.add(id);
      }

      expect(ids.size).toBe(100);
    });

    it('should work with boundary ledger sequence values', () => {
      const id0 = computeOperationId(testAddr, testTxHash, 0, testOpIndex);
      const idMax = computeOperationId(testAddr, testTxHash, 0xffffffff, testOpIndex);
      const idMid = computeOperationId(testAddr, testTxHash, 0x7fffffff, testOpIndex);

      expect(id0).not.toBe(idMax);
      expect(id0).not.toBe(idMid);
      expect(idMax).not.toBe(idMid);
    });
  });

  describe('verifyOperationChain', () => {
    const operationId = BigInt(12345);

    const createEvent = (
      eventType: string,
      timestamp: number,
      ledgerSeq: number,
      relatedId: bigint = BigInt(1)
    ): EventRecord => ({
      event_type: eventType,
      timestamp,
      ledger_seq: ledgerSeq,
      related_entity_id: relatedId,
    });

    it('should verify empty event chain as incomplete', () => {
      const result = verifyOperationChain([], operationId);

      expect(result.is_complete).toBe(false);
      expect(result.missing_events).toBeDefined();
      expect(result.missing_events?.length).toBeGreaterThan(0);
    });

    it('should verify properly sorted events as complete', () => {
      const events: EventRecord[] = [
        createEvent('StreamCreated', 1000, 100),
        createEvent('Deposited', 2000, 101),
        createEvent('Withdrawn', 3000, 102),
      ];

      const result = verifyOperationChain(events, operationId);

      expect(result.is_complete).toBe(true);
      expect(result.verification_errors).toBeUndefined();
    });

    it('should detect unsorted events', () => {
      const events: EventRecord[] = [
        createEvent('StreamCreated', 2000, 100),
        createEvent('Deposited', 1000, 101), // Earlier timestamp
        createEvent('Withdrawn', 3000, 102),
      ];

      const result = verifyOperationChain(events, operationId);

      expect(result.is_complete).toBe(false);
      expect(result.verification_errors).toBeDefined();
      expect(result.verification_errors?.length).toBeGreaterThan(0);
    });

    it('should detect suspicious time gaps', () => {
      const events: EventRecord[] = [
        createEvent('StreamCreated', 1000, 100),
        createEvent('Deposited', 1000 + 3600 + 100, 101), // More than 1 hour gap
        createEvent('Withdrawn', 1000 + 7200 + 200, 102),
      ];

      const result = verifyOperationChain(events, operationId);

      expect(result.is_complete).toBe(false);
      expect(result.missing_events).toBeDefined();
      expect(result.missing_events?.length).toBeGreaterThan(0);
    });

    it('should detect withdrawal without deposit', () => {
      const events: EventRecord[] = [
        createEvent('StreamCreated', 1000, 100),
        createEvent('Withdrawn', 2000, 101),
        createEvent('Withdrawn', 3000, 102),
      ];

      const result = verifyOperationChain(events, operationId);

      expect(result.is_complete).toBe(false);
      expect(result.missing_events).toBeDefined();
    });

    it('should detect resume without pause', () => {
      const events: EventRecord[] = [
        createEvent('StreamCreated', 1000, 100),
        createEvent('Resumed', 2000, 101),
      ];

      const result = verifyOperationChain(events, operationId);

      expect(result.is_complete).toBe(false);
      expect(result.missing_events).toBeDefined();
    });

    it('should accept pause followed by resume', () => {
      const events: EventRecord[] = [
        createEvent('StreamCreated', 1000, 100),
        createEvent('Paused', 2000, 101),
        createEvent('Resumed', 3000, 102),
      ];

      const result = verifyOperationChain(events, operationId);

      expect(result.is_complete).toBe(true);
    });

    it('should track related entity IDs', () => {
      const streamId = BigInt(999);
      const events: EventRecord[] = [
        createEvent('StreamCreated', 1000, 100, streamId),
        createEvent('Deposited', 2000, 101, streamId),
        createEvent('Withdrawn', 3000, 102, streamId),
      ];

      const result = verifyOperationChain(events, operationId);

      expect(result.events).toHaveLength(3);
      expect(result.events[0].related_entity_id).toBe(streamId);
      expect(result.events[1].related_entity_id).toBe(streamId);
      expect(result.events[2].related_entity_id).toBe(streamId);
    });

    it('should return full verification results', () => {
      const events: EventRecord[] = [
        createEvent('StreamCreated', 1000, 100),
        createEvent('Deposited', 2000, 101),
      ];

      const result = verifyOperationChain(events, operationId);

      expect(result).toHaveProperty('operation_id', operationId);
      expect(result).toHaveProperty('events');
      expect(result).toHaveProperty('is_complete');
      expect(result).toHaveProperty('missing_events');
      expect(result).toHaveProperty('verification_errors');
    });
  });

  describe('summarizeOperations', () => {
    const createChain = (
      opId: bigint,
      eventTypes: string[],
      timestamps: number[]
    ): OperationChain => ({
      operation_id: opId,
      events: eventTypes.map((type, idx) => ({
        event_type: type,
        timestamp: timestamps[idx],
        ledger_seq: 100 + idx,
        related_entity_id: BigInt(1),
      })),
      is_complete: true,
    });

    it('should summarize single operation', () => {
      const chains = [
        createChain(BigInt(1), ['StreamCreated', 'Deposited'], [1000, 2000]),
      ];

      const summary = summarizeOperations(chains);

      expect(summary.total_operations).toBe(1);
      expect(summary.total_events).toBe(2);
      expect(summary.event_types['StreamCreated']).toBe(1);
      expect(summary.event_types['Deposited']).toBe(1);
      expect(summary.date_range.earliest).toBe(1000);
      expect(summary.date_range.latest).toBe(2000);
    });

    it('should summarize multiple operations', () => {
      const chains = [
        createChain(BigInt(1), ['StreamCreated', 'Deposited'], [1000, 2000]),
        createChain(BigInt(2), ['StreamCreated', 'Withdrawn'], [3000, 4000]),
        createChain(BigInt(3), ['Deposited'], [5000]),
      ];

      const summary = summarizeOperations(chains);

      expect(summary.total_operations).toBe(3);
      expect(summary.total_events).toBe(5);
      expect(summary.event_types['StreamCreated']).toBe(2);
      expect(summary.event_types['Deposited']).toBe(2);
      expect(summary.event_types['Withdrawn']).toBe(1);
      expect(summary.date_range.earliest).toBe(1000);
      expect(summary.date_range.latest).toBe(5000);
    });

    it('should aggregate event type counts correctly', () => {
      const chains = [
        createChain(BigInt(1), ['Deposited', 'Deposited', 'Withdrawn'], [1000, 2000, 3000]),
        createChain(BigInt(2), ['Deposited', 'Withdrawn', 'Withdrawn'], [4000, 5000, 6000]),
      ];

      const summary = summarizeOperations(chains);

      expect(summary.event_types['Deposited']).toBe(3);
      expect(summary.event_types['Withdrawn']).toBe(3);
      expect(summary.total_events).toBe(6);
    });

    it('should handle empty chains array', () => {
      const summary = summarizeOperations([]);

      expect(summary.total_operations).toBe(0);
      expect(summary.total_events).toBe(0);
      expect(Object.keys(summary.event_types).length).toBe(0);
      expect(summary.date_range.earliest).toBe(0);
      expect(summary.date_range.latest).toBe(0);
    });

    it('should handle chains with no events', () => {
      const chains: OperationChain[] = [
        {
          operation_id: BigInt(1),
          events: [],
          is_complete: false,
        },
        {
          operation_id: BigInt(2),
          events: [],
          is_complete: false,
        },
      ];

      const summary = summarizeOperations(chains);

      expect(summary.total_operations).toBe(2);
      expect(summary.total_events).toBe(0);
      expect(summary.date_range.earliest).toBe(0);
      expect(summary.date_range.latest).toBe(0);
    });
  });

  describe('createMockOperationRegistryContract', () => {
    it('should create a contract instance', () => {
      const contract = createMockOperationRegistryContract();

      expect(contract).toHaveProperty('getOperationEvents');
      expect(contract).toHaveProperty('getOperationMetadata');
      expect(typeof contract.getOperationEvents).toBe('function');
      expect(typeof contract.getOperationMetadata).toBe('function');
    });

    it('should return empty events for non-existent operation', async () => {
      const contract = createMockOperationRegistryContract();
      const events = await contract.getOperationEvents(BigInt(99999));

      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBe(0);
    });

    it('should return null metadata for non-existent operation', async () => {
      const contract = createMockOperationRegistryContract();
      const metadata = await contract.getOperationMetadata(BigInt(99999));

      expect(metadata).toBeNull();
    });
  });

  describe('decodeOperationMetadata', () => {
    it('should decode metadata correctly', () => {
      const data = {
        operation_id: 12345n,
        contract_addr: 'CBWD2N7N7TYFEPZC7CTCDW3IURXFEZQSCHLXABSWN7V2TQNGWW3GCJMB',
        tx_hash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        ledger_seq: 100,
        op_index: 5,
        created_at: 1234567890,
      };

      const decoded = decodeOperationMetadata(data);

      expect(decoded.operation_id).toBe(BigInt(12345));
      expect(decoded.contract_addr).toBe(data.contract_addr);
      expect(decoded.tx_hash).toBe(data.tx_hash);
      expect(decoded.ledger_seq).toBe(100);
      expect(decoded.op_index).toBe(5);
      expect(decoded.created_at).toBe(1234567890);
    });
  });

  describe('decodeEventRecord', () => {
    it('should decode event record correctly', () => {
      const data = {
        event_type: 'StreamCreated',
        timestamp: 1234567890,
        ledger_seq: 100,
        related_entity_id: 999n,
      };

      const decoded = decodeEventRecord(data);

      expect(decoded.event_type).toBe('StreamCreated');
      expect(decoded.timestamp).toBe(1234567890);
      expect(decoded.ledger_seq).toBe(100);
      expect(decoded.related_entity_id).toBe(BigInt(999));
    });
  });
});
