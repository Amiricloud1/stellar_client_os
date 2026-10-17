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
 * Chain identity used to bind wallet flows (simulation, signing,
 * confirmation) to a specific network. Two identities are considered
 * equal only when their chain ids / passphrases match exactly.
 */
export interface ChainIdentity {
  /** Stellar network passphrase (the canonical chain id for Stellar). */
  chainId: string;
  /** Human readable network name, when known. */
  friendlyName?: string;
}

/**
 * Normalize a raw passphrase into a chain identity.
 * @param passphrase The Stellar network passphrase
 * @param friendlyName Optional friendly name to attach
 */
export function toChainIdentity(
  passphrase: string,
  friendlyName?: string
): ChainIdentity {
  if (!passphrase || typeof passphrase !== "string") {
    throw new Error("Cannot build chain identity from empty passphrase");
  }
  return { chainId: passphrase, friendlyName };
}

/**
 * Resolve the active chain identity for an RPC endpoint.
 * Uses the provided passphrase when available, otherwise detects it
 * from the RPC server.
 * @param rpcUrl The Stellar RPC server URL
 * @param providedPassphrase Optional manually provided passphrase
 */
export async function getChainIdentity(
  rpcUrl: string,
  providedPassphrase?: string
): Promise<ChainIdentity> {
  if (providedPassphrase) {
    return toChainIdentity(providedPassphrase);
  }
  const info = await detectNetworkPassphrase(rpcUrl);
  return toChainIdentity(info.passphrase, info.friendlyName);
}

/**
 * Compare two chain identities for equality.
 * Missing identities never match, so callers can safely treat a
 * missing baseline as "network changed / unknown".
 * @param a First identity
 * @param b Second identity
 * @returns true when both identities exist and refer to the same chain
 */
export function isSameChain(
  a: ChainIdentity | null | undefined,
  b: ChainIdentity | null | undefined
): boolean {
  if (!a || !b) {
    return false;
  }
  return a.chainId === b.chainId;
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
    
    // Determine friendly name based on known passphrases
    let friendlyName: string | undefined;
    if (passphrase === Networks.PUBLIC) {
      friendlyName = "Mainnet";
    } else if (passphrase === Networks.TESTNET) {
      friendlyName = "Testnet";
    } else if (passphrase === Networks.FUTURENET) {
      friendlyName = "Futurenet";
    } else if (passphrase.includes("Standalone")) {
      friendlyName = "Standalone";
    }

    return {
      passphrase,
      friendlyName,
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
