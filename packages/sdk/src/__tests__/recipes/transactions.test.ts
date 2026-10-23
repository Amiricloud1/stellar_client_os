import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { rpc } from "@stellar/stellar-sdk";
import {
  executeTransaction,
  waitForTransactionWithRetry,
  cancelStreamSafely,
  isRetryableError,
  type TransactionOutcome,
} from "../../recipes/transactions.js";

function createMockAssembledTx<T = unknown>(
  result?: T,
  hash?: string,
): AssembledTransaction<T> {
  return {
    signed: {
      hash: () => Buffer.from(hash || "abc123def456", "hex"),
    },
    result,
    signAndSend: vi.fn(async ({ signTransaction }: { signTransaction?: (xdr: string) => Promise<unknown> } = {}) => {
      if (signTransaction) await signTransaction("unsigned-xdr");
    }),
  } as any;
}

const mockGetTransaction = vi.fn();

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>(
    "@stellar/stellar-sdk",
  );
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(function () {
        return { getTransaction: mockGetTransaction };
      }),
      Api: {
        ...actual.rpc.Api,
        GetTransactionStatus: {
          SUCCESS: "SUCCESS",
          FAILED: "FAILED",
          PENDING: "PENDING",
          NOT_FOUND: "NOT_FOUND",
        },
      },
    },
  };
});

describe("executeTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns success outcome when transaction confirms", async () => {
    const tx = createMockAssembledTx(42n, "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1");
    mockGetTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 12345,
    });

    const signer = vi.fn().mockResolvedValue("signed-xdr");
    const outcome = await executeTransaction(
      tx,
      "https://soroban-testnet.stellar.org",
      signer,
      { pollInterval: 10 },
    );

    expect(outcome.success).toBe(true);
    expect(outcome.hash).toBe("a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1");
    expect(outcome.ledger).toBe(12345);
    expect(outcome.result).toBe(42n);
    expect(outcome.error).toBeUndefined();
  });

  it("returns failure outcome when transaction fails", async () => {
    const tx = createMockAssembledTx(null, "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2");
    mockGetTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.FAILED,
      ledger: 99999,
      resultXdr: "AAAAAA==",
    });

    const signer = vi.fn().mockResolvedValue("signed-xdr");
    const outcome = await executeTransaction(
      tx,
      "https://soroban-testnet.stellar.org",
      signer,
      { pollInterval: 10 },
    );

    expect(outcome.success).toBe(false);
    expect(outcome.hash).toBe("b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2");
    expect(outcome.error).toBeDefined();
    expect(outcome.error?.message).toBeDefined();
  });

  it("encodes Uint8Array transaction hashes as hex on failure", async () => {
    const tx = createMockAssembledTx();
    vi.spyOn(tx.signed!, "hash").mockReturnValue(new Uint8Array([0, 171, 255]));
    const signer = vi.fn().mockRejectedValue(new Error("Wallet rejected transaction"));

    const outcome = await executeTransaction(
      tx,
      "https://soroban-testnet.stellar.org",
      signer,
    );

    expect(outcome.success).toBe(false);
    expect(outcome.hash).toBe("00abff");
  });

  it("returns failure outcome when signer throws", async () => {
    const tx = createMockAssembledTx(null, "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3");
    const signer = vi.fn().mockRejectedValue(new Error("Wallet rejected transaction"));

    const outcome = await executeTransaction(
      tx,
      "https://soroban-testnet.stellar.org",
      signer,
    );

    expect(outcome.success).toBe(false);
    expect(outcome.error?.message).toBeDefined();
    expect(outcome.error?.type).toBeDefined();
  });
});

describe("waitForTransactionWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates to waitForTransaction and returns result", async () => {
    const tx = createMockAssembledTx(100n, "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4");
    mockGetTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 54321,
    });

    const result = await waitForTransactionWithRetry(
      tx,
      "https://test.stellar.org",
      { pollInterval: 10 },
    );

    expect(result.ledger).toBe(54321);
    expect(result.result).toBe(100n);
  });
});

describe("cancelStreamSafely", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns success outcome for cancellation", async () => {
    const cancelTx = createMockAssembledTx(true, "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5");
    mockGetTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 77777,
    });

    const signer = vi.fn().mockResolvedValue("signed-xdr");
    const outcome = await cancelStreamSafely(
      cancelTx,
      "https://soroban-testnet.stellar.org",
      signer,
      { pollInterval: 10 },
    );

    expect(outcome.success).toBe(true);
    expect(outcome.hash).toBe("e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5");
    expect(outcome.ledger).toBe(77777);
  });
});

describe("isRetryableError", () => {
  it("returns true for timeout errors", () => {
    expect(isRetryableError(new Error("Transaction confirmation timeout"))).toBe(true);
  });

  it("returns true for network errors", () => {
    expect(isRetryableError(new Error("Network error occurred"))).toBe(true);
  });

  it("returns true for connection refused", () => {
    expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
  });

  it("returns true for connection reset", () => {
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
  });

  it("returns true for 'not found' errors", () => {
    expect(isRetryableError(new Error("Transaction not found"))).toBe(true);
  });

  it("returns false for non-Error values", () => {
    expect(isRetryableError("string error")).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });

  it("returns false for unknown error messages", () => {
    expect(isRetryableError(new Error("Something went wrong"))).toBe(false);
  });
});
