/**
 * Network detection utilities for Stellar
 * 
 * Auto-detect network passphrase from RPC server status
 * to reduce configuration boilerplate for SDK users.
 */

import { rpc, Networks } from "@stellar/stellar-sdk";

export interface NetworkInfo {
  passphrase: string;
  friendlyName?: string;
  protocolVersion?: number;
}

/**
 * Stable, machine-readable signal describing a wallet/RPC network mismatch.
 *
 * Consumers (e.g. the web wallet's switch-network recovery action) should
 * branch on `code` rather than parsing human-readable messages, so the
 * mismatch can be detected reliably across wallet flows.
 */
export const NETWORK_MISMATCH_CODE = "NETWORK_MISMATCH" as const;

export interface NetworkMismatch {
  code: typeof NETWORK_MISMATCH_CODE;
  /** Passphrase the wallet is currently configured with. */
  expectedPassphrase: string;
  /** Passphrase reported by the RPC server. */
  actualPassphrase: string;
  /** Friendly name for the expected network, when known. */
  expectedFriendlyName?: string;
  /** Friendly name for the actual network, when known. */
  actualFriendlyName?: string;
  /** Human-readable message suitable for display. */
  message: string;
}

/**
 * Resolve a friendly network name from a passphrase.
 * @param passphrase The network passphrase
 * @returns Friendly name when the passphrase is recognized
 */
export function getFriendlyNetworkName(
  passphrase: string
): string | undefined {
  if (passphrase === Networks.PUBLIC) {
    return "Mainnet";
  }
  if (passphrase === Networks.TESTNET) {
    return "Testnet";
  }
  if (passphrase === Networks.FUTURENET) {
    return "Futurenet";
  }
  if (passphrase.includes("Standalone")) {
    return "Standalone";
  }
  return undefined;
}

/**
 * Compare a wallet's configured passphrase against an RPC-reported passphrase.
 * @param expectedPassphrase Passphrase the wallet is configured with
 * @param actualPassphrase Passphrase reported by the RPC server
 * @returns A NetworkMismatch when the passphrases differ, otherwise null
 */
export function detectNetworkMismatch(
  expectedPassphrase: string,
  actualPassphrase: string
): NetworkMismatch | null {
  if (expectedPassphrase === actualPassphrase) {
    return null;
  }

  const expectedFriendlyName = getFriendlyNetworkName(expectedPassphrase);
  const actualFriendlyName = getFriendlyNetworkName(actualPassphrase);

  return {
    code: NETWORK_MISMATCH_CODE,
    expectedPassphrase,
    actualPassphrase,
    expectedFriendlyName,
    actualFriendlyName,
    message: `Wallet is on ${
      expectedFriendlyName ?? expectedPassphrase
    } but the RPC server is on ${
      actualFriendlyName ?? actualPassphrase
    }. Switch networks to continue.`,
  };
}

/**
 * Type guard for a NetworkMismatch signal.
 * @param value Any value to test
 * @returns True when the value is a NetworkMismatch
 */
export function isNetworkMismatch(value: unknown): value is NetworkMismatch {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { code?: unknown }).code === NETWORK_MISMATCH_CODE
  );
}

/**
 * Detect the network passphrase from an RPC server
 * @param rpcUrl The Stellar RPC server URL
 * @returns Network information including passphrase
 */
export async function detectNetworkPassphrase(
  rpcUrl: string
): Promise<NetworkInfo> {
  const server = new rpc.Server(rpcUrl);
  
  try {
    // Fetch network information from RPC
    const health = await server.getHealth();
    
    // Get network details - the RPC server exposes network passphrase
    // in its getNetwork() method
    const network = await server.getNetwork();
    
    const passphrase = network.passphrase;

    return {
      passphrase,
      friendlyName: getFriendlyNetworkName(passphrase),
      protocolVersion: Number(network.protocolVersion),
    };
  } catch (error) {
    throw new Error(
      `Failed to detect network passphrase from ${rpcUrl}: ${error}`
    );
  }
}

/**
 * Get network passphrase with fallback
 * If passphrase is provided, use it. Otherwise, detect from RPC.
 * @param rpcUrl The Stellar RPC server URL
 * @param providedPassphrase Optional manually provided passphrase
 * @returns The network passphrase to use
 */
export async function getNetworkPassphrase(
  rpcUrl: string,
  providedPassphrase?: string
): Promise<string> {
  if (providedPassphrase) {
    return providedPassphrase;
  }
  
  const networkInfo = await detectNetworkPassphrase(rpcUrl);
  return networkInfo.passphrase;
}

/**
 * Check if an RPC URL is reachable and return network info
 * @param rpcUrl The Stellar RPC server URL
 * @returns Network info if reachable, null otherwise
 */
export async function checkRpcConnection(
  rpcUrl: string
): Promise<NetworkInfo | null> {
  try {
    return await detectNetworkPassphrase(rpcUrl);
  } catch (error) {
    return null;
  }
}

/**
 * Detect the RPC network and compare it against the wallet's passphrase.
 * @param rpcUrl The Stellar RPC server URL
 * @param expectedPassphrase Passphrase the wallet is configured with
 * @returns The detected network info and any mismatch signal
 */
export async function checkNetworkMatch(
  rpcUrl: string,
  expectedPassphrase: string
): Promise<{ network: NetworkInfo; mismatch: NetworkMismatch | null }> {
  const network = await detectNetworkPassphrase(rpcUrl);
  return {
    network,
    mismatch: detectNetworkMismatch(expectedPassphrase, network.passphrase),
  };
}
