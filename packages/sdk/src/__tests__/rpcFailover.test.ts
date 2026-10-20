import { describe, it, expect, vi } from 'vitest';
import {
  classifyRpcError,
  RpcFailoverClient,
  RpcFailoverError,
} from '../utils/rpcFailover.js';

describe('RPC Failover and Error Classification', () => {
  describe('classifyRpcError', () => {
    it('classifies rate limiting (429) as transient', () => {
      expect(classifyRpcError({ status: 429, message: 'Too Many Requests' })).toBe('transient');
      expect(classifyRpcError(new Error('HTTP 429: rate limit exceeded'))).toBe('transient');
    });

    it('classifies server gateway errors (502, 503, 504) as transient', () => {
      expect(classifyRpcError({ statusCode: 503 })).toBe('transient');
      expect(classifyRpcError(new Error('504 Gateway Timeout'))).toBe('transient');
      expect(classifyRpcError(new Error('Service Unavailable'))).toBe('transient');
    });

    it('classifies connection reset / network drop as transient', () => {
      expect(classifyRpcError(new Error('ECONNRESET'))).toBe('transient');
      expect(classifyRpcError(new Error('ETIMEDOUT'))).toBe('transient');
      expect(classifyRpcError(new Error('TypeError: Failed to fetch'))).toBe('transient');
    });

    it('classifies contract panic / simulation failure as deterministic', () => {
      expect(classifyRpcError(new Error('HostError: Error(Contract, #4)'))).toBe('deterministic');
      expect(classifyRpcError(new Error('simulation_error: Unauthorized'))).toBe('deterministic');
      expect(classifyRpcError({ status: 400, message: 'Bad Request: invalid argument' })).toBe('deterministic');
      expect(classifyRpcError({ status: 401, message: 'Unauthorized' })).toBe('deterministic');
    });
  });

  describe('RpcFailoverClient', () => {
    it('succeeds on primary endpoint when healthy', async () => {
      const client = new RpcFailoverClient([
        'https://rpc1.stellar.org',
        'https://rpc2.stellar.org',
      ]);

      const result = await client.execute(async (url) => {
        return `response from ${url}`;
      });

      expect(result).toBe('response from https://rpc1.stellar.org');
    });

    it('immediately throws deterministic contract error without retry', async () => {
      const client = new RpcFailoverClient([
        'https://rpc1.stellar.org',
        'https://rpc2.stellar.org',
      ]);

      let callCount = 0;
      await expect(
        client.execute(async () => {
          callCount++;
          throw new Error('HostError: Error(Contract, #4)');
        })
      ).rejects.toThrow(/HostError: Error\(Contract, #4\)/);

      expect(callCount).toBe(1);
    });

    it('fails over to secondary endpoint on transient failure', async () => {
      const client = new RpcFailoverClient(
        ['https://rpc1.stellar.org', 'https://rpc2.stellar.org'],
        { initialBackoffMs: 1, maxBackoffMs: 5, jitter: false }
      );

      const calledUrls: string[] = [];
      const result = await client.execute(async (url) => {
        calledUrls.push(url);
        if (url === 'https://rpc1.stellar.org') {
          throw new Error('HTTP 503 Service Unavailable');
        }
        return 'success from rpc2';
      });

      expect(result).toBe('success from rpc2');
      expect(calledUrls).toEqual([
        'https://rpc1.stellar.org',
        'https://rpc2.stellar.org',
      ]);
    });

    it('throws RpcFailoverError when all retries are exhausted', async () => {
      const client = new RpcFailoverClient(
        ['https://rpc1.stellar.org', 'https://rpc2.stellar.org'],
        { maxRetries: 2, initialBackoffMs: 1, maxBackoffMs: 5, jitter: false }
      );

      let attempts = 0;
      await expect(
        client.execute(async () => {
          attempts++;
          throw new Error('ETIMEDOUT');
        })
      ).rejects.toThrow(RpcFailoverError);

      expect(attempts).toBe(3); // Initial attempt + 2 retries
    });
  });
});
