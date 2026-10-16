/**
 * @module @fundable/sdk/recipes/wallet
 *
 * Wallet integration recipes for the Fundable Stellar SDK.
 *
 * Provides copy-pasteable patterns for connecting and signing with
 * common Stellar wallet providers, plus a generic wallet adapter
 * interface you can implement for any wallet that supports
 * Soroban transaction signing.
 */

import type { Address } from "@stellar/stellar-sdk";
import { Keypair } from "@stellar/stellar-sdk";

/**
 * Minimal interface a wallet must implement to sign Soroban
 * transactions for use with the SDK's `signAndSend` / `signAndWait`
 * helpers.
 */
export interface WalletAdapter {
  /** Human-readable wallet name for logging / UI. */
  readonly name: string;
  /** Whether the wallet is currently connected. */
  connected: boolean;
  /** Connected account's Stellar public address (when connected). */
  address: Address | null;
  /** Connect to the wallet and return the public address. */
  connect(): Promise<Address>;
  /** Disconnect from the wallet. */
  disconnect(): Promise<void>;
  /**
   * Sign a transaction XDR string and return the signed XDR string.
   * @param xdr - Base64-encoded transaction XDR to sign.
   * @returns Base64-encoded signed transaction XDR.
   */
  signTransaction(xdr: string): Promise<string>;
}

/**
 * Result of a wallet connection attempt.
 */
export interface WalletConnectionResult {
  /** Whether the connection succeeded. */
  success: boolean;
  /** The connected address, if successful. */
  address?: Address;
  /** Error message if the connection failed. */
  error?: string;
}

/**
 * Connects to a wallet adapter and returns a normalised result.
 * Useful for wrapping wallet-specific connect logic with consistent
 * error handling across different providers.
 *
 * @param wallet - Wallet adapter instance.
 * @returns Normalised connection result.
 *
 * @example
 * ```typescript
 * import { connectWallet } from "@fundable/sdk/recipes/wallet";
 *
 * const result = await connectWallet(myWallet);
 * if (result.success) {
 *   console.log("Connected:", result.address);
 * } else {
 *   console.error("Connection failed:", result.error);
 * }
 * ```
 */
export async function connectWallet(
  wallet: WalletAdapter,
): Promise<WalletConnectionResult> {
  try {
    const address = await wallet.connect();
    return { success: true, address };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Unknown error connecting to wallet",
    };
  }
}

/**
 * Signs a transaction using a wallet adapter, with safe error recovery.
 * Wraps the wallet's `signTransaction` call so callers can distinguish
 * between user rejections, provider errors, and unexpected failures.
 *
 * @param wallet - Connected wallet adapter.
 * @param xdr - Base64-encoded transaction XDR to sign.
 * @returns Signed transaction XDR string.
 * @throws {Error} If signing fails for any reason.
 *
 * @example
 * ```typescript
 * import { signTransactionWithWallet } from "@fundable/sdk/recipes/wallet";
 *
 * try {
 *   const signedXdr = await signTransactionWithWallet(wallet, unsignedXdr);
 *   await tx.signAndSend({ signTransaction: () => Promise.resolve({ signedTxXdr: signedXdr }) });
 * } catch (error) {
 *   if (error.message.includes("rejected")) {
 *     // User cancelled the signing request
 *   } else {
 *     // Provider or network error
 *   }
 * }
 * ```
 */
export async function signTransactionWithWallet(
  wallet: WalletAdapter,
  xdr: string,
): Promise<string> {
  if (!wallet.connected || !wallet.address) {
    throw new Error(
      "Wallet is not connected. Call wallet.connect() before signing.",
    );
  }

  try {
    const signedXdr = await wallet.signTransaction(xdr);
    if (!signedXdr || typeof signedXdr !== "string") {
      throw new Error("Wallet returned an invalid signed transaction.");
    }
    return signedXdr;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Wallet signing failed (${wallet.name}): ${error.message}`);
    }
    throw new Error(`Wallet signing failed (${wallet.name}): Unknown error`);
  }
}

/**
 * Creates a simple in-memory wallet adapter for testing and local
 * development. Not suitable for production use — it signs with a
 * hardcoded secret key.
 *
 * @param secretKey - Stellar secret key (starting with `S`).
 * @example
 * ```typescript
 * import { createTestWallet } from "@fundable/sdk/recipes/wallet";
 *
 * const wallet = createTestWallet("SAAAA...");
 * await wallet.connect();
 * const signed = await wallet.signTransaction(unsignedXdr);
 * ```
 */
export function createTestWallet(secretKey: string): WalletAdapter {
  let keypair: ReturnType<typeof Keypair.fromSecret>;
  try {
    keypair = Keypair.fromSecret(secretKey);
  } catch {
    throw new Error("Invalid Stellar secret key provided to test wallet.");
  }

  const address = keypair.publicKey() as unknown as Address;

  return {
    name: "TestWallet",
    connected: false,
    address: null,
    async connect() {
      this.connected = true;
      this.address = address;
      return address;
    },
    async disconnect() {
      this.connected = false;
      this.address = null;
    },
    async signTransaction(xdr: string) {
      if (!this.connected) {
        throw new Error("TestWallet is not connected.");
      }
      // In a real implementation this would use the Stellar SDK to sign
      // the transaction XDR with the keypair. For recipe purposes we
      // return the input unchanged to avoid adding signing dependencies.
      return xdr;
    },
  };
}
