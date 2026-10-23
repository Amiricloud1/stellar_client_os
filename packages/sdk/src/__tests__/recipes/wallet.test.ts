import { Keypair } from "@stellar/stellar-sdk";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  connectWallet,
  signTransactionWithWallet,
  createTestWallet,
  type WalletAdapter,
} from "../../recipes/wallet.js";

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Keypair: {
      ...actual.Keypair,
      fromSecret: vi.fn(),
    },
  };
});

function createMockWallet(overrides: Partial<WalletAdapter> = {}): WalletAdapter {
  return {
    name: "MockWallet",
    connected: false,
    address: null,
    connect: vi.fn().mockResolvedValue("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"),
    disconnect: vi.fn().mockResolvedValue(undefined),
    signTransaction: vi.fn().mockResolvedValue("signed-xdr"),
    ...overrides,
  } as WalletAdapter;
}

describe("connectWallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success when wallet connects", async () => {
    const wallet = createMockWallet();
    const result = await connectWallet(wallet);

    expect(result.success).toBe(true);
    expect(result.address).toBe("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
    expect(wallet.connect).toHaveBeenCalledTimes(1);
  });

  it("returns failure when wallet connect throws", async () => {
    const wallet = createMockWallet({
      connect: vi.fn().mockRejectedValue(new Error("User rejected")),
    });
    const result = await connectWallet(wallet);

    expect(result.success).toBe(false);
    expect(result.error).toBe("User rejected");
    expect(result.address).toBeUndefined();
  });

  it("handles non-Error throw values", async () => {
    const wallet = createMockWallet({
      connect: vi.fn().mockRejectedValue("string error"),
    });
    const result = await connectWallet(wallet);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Unknown error connecting to wallet");
  });
});

describe("signTransactionWithWallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("signs transaction when wallet is connected", async () => {
    const wallet = createMockWallet({ connected: true, address: "G" + "A".repeat(55) as any });
    const signed = await signTransactionWithWallet(wallet, "unsigned-xdr");

    expect(signed).toBe("signed-xdr");
    expect(wallet.signTransaction).toHaveBeenCalledWith("unsigned-xdr");
  });

  it("throws when wallet is not connected", async () => {
    const wallet = createMockWallet({ connected: false, address: null });
    await expect(
      signTransactionWithWallet(wallet, "unsigned-xdr"),
    ).rejects.toThrow(/not connected/i);
  });

  it("throws when wallet has no address", async () => {
    const wallet = createMockWallet({ connected: true, address: null });
    await expect(
      signTransactionWithWallet(wallet, "unsigned-xdr"),
    ).rejects.toThrow(/not connected/i);
  });

  it("wraps signing errors with wallet name", async () => {
    const wallet = createMockWallet({
      connected: true,
      address: "G" + "A".repeat(55) as any,
      signTransaction: vi.fn().mockRejectedValue(new Error("Wallet locked")),
    });
    await expect(
      signTransactionWithWallet(wallet, "unsigned-xdr"),
    ).rejects.toThrow(/MockWallet/);
  });

  it("throws when wallet returns invalid signed XDR", async () => {
    const wallet = createMockWallet({
      connected: true,
      address: "G" + "A".repeat(55) as any,
      signTransaction: vi.fn().mockResolvedValue(""),
    });
    await expect(
      signTransactionWithWallet(wallet, "unsigned-xdr"),
    ).rejects.toThrow(/invalid signed transaction/i);
  });
});

describe("createTestWallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up the mock to return a valid keypair object
    vi.mocked(Keypair).fromSecret.mockReturnValue({
      publicKey: () => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    } as any);
  });

  it("creates a wallet adapter from a secret key", () => {
    const wallet = createTestWallet("SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB6");

    expect(wallet.name).toBe("TestWallet");
    expect(wallet.connected).toBe(false);
    expect(wallet.address).toBeNull();
  });

  it("throws on invalid secret key", () => {
    vi.mocked(Keypair).fromSecret.mockImplementation(() => {
      throw new Error("Invalid secret");
    });

    expect(() => createTestWallet("invalid-key")).toThrow(
      /Invalid Stellar secret key/i,
    );
  });

  it("connects and returns address", async () => {
    const wallet = createTestWallet("SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB6");
    const address = await wallet.connect();

    expect(wallet.connected).toBe(true);
    expect(wallet.address).toBe(address);
    expect(typeof address).toBe("string");
    expect((address as unknown as string).startsWith("G")).toBe(true);
  });

  it("disconnects and clears state", async () => {
    const wallet = createTestWallet("SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB6");
    await wallet.connect();
    await wallet.disconnect();

    expect(wallet.connected).toBe(false);
    expect(wallet.address).toBeNull();
  });

  it("throws when signing without connecting", async () => {
    const wallet = createTestWallet("SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB6");
    await expect(
      wallet.signTransaction("unsigned-xdr"),
    ).rejects.toThrow(/not connected/i);
  });
});
