import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TransactionStatus,
  ResubmissionDecision,
  resolveTransactionStatus,
  shouldResubmit,
  safeResubmitTransaction,
  pollTransactionStatus,
  type TransactionStatusResult,
  type RpcClient,
  type TransactionRequest,
} from './transactions';

/**
 * Deterministic unit tests for the safe transaction resubmission flow.
 *
 * All RPC interactions are mocked. No live funds or network access is used.
 */

interface MockRpcClient extends RpcClient {
  getTransactionStatus: ReturnType<typeof vi.fn>;
  sendRawTransaction: ReturnType<typeof vi.fn>;
}

function createMockRpcClient(): MockRpcClient {
  return {
    getTransactionStatus: vi.fn(),
    sendRawTransaction: vi.fn(),
  } as unknown as MockRpcClient;
}

const SAMPLE_TX: TransactionRequest = {
  signature: '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW',
  rawTransaction: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAEDJ',
};

describe('resolveTransactionStatus', () => {
  let rpc: MockRpcClient;

  beforeEach(() => {
    rpc = createMockRpcClient();
  });

  it('returns CONFIRMED when the RPC reports a confirmed transaction', async () => {
    rpc.getTransactionStatus.mockResolvedValue({
      status: TransactionStatus.CONFIRMED,
      slot: 12345,
    });

    const result = await resolveTransactionStatus(rpc, SAMPLE_TX.signature);

    expect(result.status).toBe(TransactionStatus.CONFIRMED);
    expect(result.slot).toBe(12345);
    expect(rpc.getTransactionStatus).toHaveBeenCalledTimes(1);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('returns FAILED when the RPC reports a failed transaction', async () => {
    rpc.getTransactionStatus.mockResolvedValue({
      status: TransactionStatus.FAILED,
      error: 'InstructionError',
    });

    const result = await resolveTransactionStatus(rpc, SAMPLE_TX.signature);

    expect(result.status).toBe(TransactionStatus.FAILED);
    expect(result.error).toBe('InstructionError');
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('returns PENDING when the RPC reports a pending transaction', async () => {
    rpc.getTransactionStatus.mockResolvedValue({
      status: TransactionStatus.PENDING,
    });

    const result = await resolveTransactionStatus(rpc, SAMPLE_TX.signature);

    expect(result.status).toBe(TransactionStatus.PENDING);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when the RPC reports an unknown transaction', async () => {
    rpc.getTransactionStatus.mockResolvedValue({
      status: TransactionStatus.NOT_FOUND,
    });

    const result = await resolveTransactionStatus(rpc, SAMPLE_TX.signature);

    expect(result.status).toBe(TransactionStatus.NOT_FOUND);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('treats an ambiguous timeout as UNKNOWN rather than resubmitting', async () => {
    rpc.getTransactionStatus.mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await resolveTransactionStatus(rpc, SAMPLE_TX.signature);

    expect(result.status).toBe(TransactionStatus.UNKNOWN);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe('shouldResubmit', () => {
  it('never resubmits a CONFIRMED transaction', () => {
    const result: TransactionStatusResult = { status: TransactionStatus.CONFIRMED, slot: 1 };
    expect(shouldResubmit(result)).toBe(false);
  });

  it('never resubmits a FAILED transaction', () => {
    const result: TransactionStatusResult = { status: TransactionStatus.FAILED, error: 'boom' };
    expect(shouldResubmit(result)).toBe(false);
  });

  it('does not resubmit a PENDING transaction (poll instead)', () => {
    const result: TransactionStatusResult = { status: TransactionStatus.PENDING };
    expect(shouldResubmit(result)).toBe(false);
  });

  it('resubmits a NOT_FOUND transaction when safe', () => {
    const result: TransactionStatusResult = { status: TransactionStatus.NOT_FOUND };
    expect(shouldResubmit(result, { allowResubmit: true })).toBe(true);
  });

  it('does not resubmit a NOT_FOUND transaction when resubmission is disallowed', () => {
    const result: TransactionStatusResult = { status: TransactionStatus.NOT_FOUND };
    expect(shouldResubmit(result, { allowResubmit: false })).toBe(false);
  });

  it('does not resubmit an UNKNOWN transaction by default', () => {
    const result: TransactionStatusResult = { status: TransactionStatus.UNKNOWN };
    expect(shouldResubmit(result)).toBe(false);
  });

  it('resubmits an UNKNOWN transaction only after the timeout boundary is exceeded', () => {
    const result: TransactionStatusResult = { status: TransactionStatus.UNKNOWN };
    expect(
      shouldResubmit(result, { allowResubmit: true, elapsedMs: 500, timeoutMs: 1000 }),
    ).toBe(false);
    expect(
      shouldResubmit(result, { allowResubmit: true, elapsedMs: 1000, timeoutMs: 1000 }),
    ).toBe(true);
    expect(
      shouldResubmit(result, { allowResubmit: true, elapsedMs: 1500, timeoutMs: 1000 }),
    ).toBe(true);
  });
});

describe('safeResubmitTransaction', () => {
  let rpc: MockRpcClient;

  beforeEach(() => {
    rpc = createMockRpcClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not resubmit a confirmed transaction', async () => {
    rpc.getTransactionStatus.mockResolvedValue({
      status: TransactionStatus.CONFIRMED,
      slot: 42,
    });

    const decision = await safeResubmitTransaction(rpc, SAMPLE_TX);

    expect(decision.decision).toBe(ResubmissionDecision.SKIP_CONFIRMED);
    expect(decision.resubmitted).toBe(false);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('does not resubmit a failed transaction', async () => {
    rpc.getTransactionStatus.mockResolvedValue({
      status: TransactionStatus.FAILED,
      error: 'InsufficientFunds',
    });

    const decision = await safeResubmitTransaction(rpc, SAMPLE_TX);

    expect(decision.decision).toBe(ResubmissionDecision.SKIP_FAILED);
    expect(decision.resubmitted).toBe(false);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('polls a pending transaction rather than resubmitting it', async () => {
    rpc.getTransactionStatus
      .mockResolvedValueOnce({ status: TransactionStatus.PENDING })
      .mockResolvedValueOnce({ status: TransactionStatus.PENDING })
      .mockResolvedValueOnce({ status: TransactionStatus.CONFIRMED, slot: 7 });

    const decision = await safeResubmitTransaction(rpc, SAMPLE_TX, {
      pollIntervalMs: 0,
      maxPolls: 5,
    });

    expect(decision.decision).toBe(ResubmissionDecision.SKIP_CONFIRMED);
    expect(decision.resubmitted).toBe(false);
    expect(rpc.getTransactionStatus).toHaveBeenCalledTimes(3);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('resubmits a NOT_FOUND transaction when safe', async () => {
    rpc.getTransactionStatus.mockResolvedValue({ status: TransactionStatus.NOT_FOUND });
    rpc.sendRawTransaction.mockResolvedValue({ signature: SAMPLE_TX.signature });

    const decision = await safeResubmitTransaction(rpc, SAMPLE_TX, {
      allowResubmit: true,
    });

    expect(decision.decision).toBe(ResubmissionDecision.RESUBMITTED);
    expect(decision.resubmitted).toBe(true);
    expect(rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(rpc.sendRawTransaction).toHaveBeenCalledWith(SAMPLE_TX.rawTransaction);
  });

  it('does not resubmit a NOT_FOUND transaction when resubmission is disallowed', async () => {
    rpc.getTransactionStatus.mockResolvedValue({ status: TransactionStatus.NOT_FOUND });

    const decision = await safeResubmitTransaction(rpc, SAMPLE_TX, {
      allowResubmit: false,
    });

    expect(decision.decision).toBe(ResubmissionDecision.SKIP_NOT_FOUND);
    expect(decision.resubmitted).toBe(false);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('does not resubmit an UNKNOWN transaction before the timeout boundary', async () => {
    rpc.getTransactionStatus.mockRejectedValue(new Error('ETIMEDOUT'));

    const decision = await safeResubmitTransaction(rpc, SAMPLE_TX, {
      allowResubmit: true,
      elapsedMs: 100,
      timeoutMs: 1000,
    });

    expect(decision.decision).toBe(ResubmissionDecision.SKIP_UNKNOWN);
    expect(decision.resubmitted).toBe(false);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('resubmits an UNKNOWN transaction at the timeout boundary when allowed', async () => {
    rpc.getTransactionStatus.mockRejectedValue(new Error('ETIMEDOUT'));
    rpc.sendRawTransaction.mockResolvedValue({ signature: SAMPLE_TX.signature });

    const decision = await safeResubmitTransaction(rpc, SAMPLE_TX, {
      allowResubmit: true,
      elapsedMs: 1000,
      timeoutMs: 1000,
    });

    expect(decision.decision).toBe(ResubmissionDecision.RESUBMITTED);
    expect(decision.resubmitted).toBe(true);
    expect(rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('propagates a resubmission failure without marking it as resubmitted', async () => {
    rpc.getTransactionStatus.mockResolvedValue({ status: TransactionStatus.NOT_FOUND });
    rpc.sendRawTransaction.mockRejectedValue(new Error('blockhash not found'));

    const decision = await safeResubmitTransaction(rpc, SAMPLE_TX, {
      allowResubmit: true,
    });

    expect(decision.decision).toBe(ResubmissionDecision.RESUBMIT_FAILED);
    expect(decision.resubmitted).toBe(false);
    expect(decision.error).toBeDefined();
  });
});

describe('pollTransactionStatus', () => {
  let rpc: MockRpcClient;

  beforeEach(() => {
    rpc = createMockRpcClient();
  });

  it('resolves once the transaction is confirmed', async () => {
    rpc.getTransactionStatus
      .mockResolvedValueOnce({ status: TransactionStatus.PENDING })
      .mockResolvedValueOnce({ status: TransactionStatus.CONFIRMED, slot: 99 });

    const result = await pollTransactionStatus(rpc, SAMPLE_TX.signature, {
      pollIntervalMs: 0,
      maxPolls: 5,
    });

    expect(result.status).toBe(TransactionStatus.CONFIRMED);
    expect(result.slot).toBe(99);
    expect(rpc.getTransactionStatus).toHaveBeenCalledTimes(2);
  });

  it('stops polling after maxPolls and returns the last status', async () => {
    rpc.getTransactionStatus.mockResolvedValue({ status: TransactionStatus.PENDING });

    const result = await pollTransactionStatus(rpc, SAMPLE_TX.signature, {
      pollIntervalMs: 0,
      maxPolls: 3,
    });

    expect(result.status).toBe(TransactionStatus.PENDING);
    expect(rpc.getTransactionStatus).toHaveBeenCalledTimes(3);
  });

  it('returns FAILED immediately without further polling', async () => {
    rpc.getTransactionStatus.mockResolvedValue({
      status: TransactionStatus.FAILED,
      error: 'boom',
    });

    const result = await pollTransactionStatus(rpc, SAMPLE_TX.signature, {
      pollIntervalMs: 0,
      maxPolls: 5,
    });

    expect(result.status).toBe(TransactionStatus.FAILED);
    expect(rpc.getTransactionStatus).toHaveBeenCalledTimes(1);
  });
});