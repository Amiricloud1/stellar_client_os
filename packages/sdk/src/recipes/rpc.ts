/**
 * @module @fundable/sdk/recipes/rpc
 *
 * RPC provider configuration recipes for the Fundable Stellar SDK.
 *
 * Provides preset configurations for Testnet, Mainnet, and local
 * development RPC endpoints, plus helpers for building client
 * configurations used by SDK contract clients.
 */

import { resolveRpcServerOptions, isLoopbackHttpUrl } from "../utils/rpcConnectionOptions.js";

/**
 * Known Stellar network presets with default RPC URLs and passphrases.
 */
export const STELLAR_NETWORKS = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    allowHttp: false,
  },
  mainnet: {
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    rpcUrl: "https://soroban-mainnet.stellar.org",
    horizonUrl: "https://horizon.stellar.org",
    allowHttp: false,
  },
  local: {
    networkPassphrase: "Standalone Network ; February 2017",
    rpcUrl: "http://localhost:8000",
    horizonUrl: "http://localhost:8000",
    allowHttp: true,
  },
} as const;

/**
 * Network identifier type.
 */
export type StellarNetwork = keyof typeof STELLAR_NETWORKS;

/**
 * Configuration for connecting an SDK client to a Stellar network.
 */
export interface RpcProviderConfig {
  /** Network identifier (testnet, mainnet, or local). */
  network: StellarNetwork;
  /** Full network passphrase used to sign transactions. */
  networkPassphrase: string;
  /** Soroban RPC endpoint URL. */
  rpcUrl: string;
  /** Horizon RPC endpoint URL (optional, for balance/ledger queries). */
  horizonUrl?: string;
  /** Whether to allow plain HTTP (only safe for loopback local dev). */
  allowHttp?: boolean;
}

/**
 * Builds an RpcProviderConfig from a known network preset.
 * Throws if the network name is not recognised.
 *
 * @param network - Network identifier (testnet, mainnet, local).
 * @param overrides - Optional overrides for any config field.
 * @returns Validated RPC provider configuration.
 *
 * @example
 * ```typescript
 * import { getRpcProviderConfig } from "@fundable/sdk/recipes/rpc";
 *
 * const config = getRpcProviderConfig("testnet");
 * const client = new PaymentStreamClient({
 *   contractId: "...",
 *   ...config,
 * });
 * ```
 */
export function getRpcProviderConfig(
  network: StellarNetwork,
  overrides: Partial<RpcProviderConfig> = {},
): RpcProviderConfig {
  const preset = STELLAR_NETWORKS[network];
  if (!preset) {
    throw new Error(
      `Unknown Stellar network: "${network}". ` +
        `Expected one of: ${Object.keys(STELLAR_NETWORKS).join(", ")}`,
    );
  }

  const config: RpcProviderConfig = {
    network,
    networkPassphrase: preset.networkPassphrase,
    rpcUrl: preset.rpcUrl,
    horizonUrl: preset.horizonUrl,
    allowHttp: preset.allowHttp,
    ...overrides,
  };

  // Validate that non-loopback HTTP URLs are rejected.
  const { allowHttp } = resolveRpcServerOptions(config.rpcUrl, {
    allowHttp: config.allowHttp ?? false,
  });
  config.allowHttp = allowHttp;

  return config;
}

/**
 * Returns the allowHttp server option for a given URL, applying the same
 * security rules used by the SDK's RPC connection layer.
 *
 * @param rpcUrl - RPC endpoint URL.
 * @param allowHttp - Explicit opt-in for plain HTTP (loopback only).
 * @returns `{ allowHttp: boolean }` suitable for passing to RPC server constructors.
 *
 * @example
 * ```typescript
 * import { getRpcServerOptions } from "@fundable/sdk/recipes/rpc";
 *
 * const options = getRpcServerOptions("https://soroban-testnet.stellar.org");
 * // { allowHttp: false }
 *
 * const localOptions = getRpcServerOptions("http://localhost:8000", true);
 * // { allowHttp: true }
 * ```
 */
export function getRpcServerOptions(
  rpcUrl: string,
  allowHttp?: boolean,
): { allowHttp: boolean } {
  return resolveRpcServerOptions(rpcUrl, { allowHttp: allowHttp ?? false });
}

/**
 * Checks whether a URL is a plain-HTTP loopback URL (safe for local dev).
 *
 * @param rpcUrl - URL to check.
 * @returns `true` if the URL uses plain HTTP against localhost/127.0.0.1/[::1].
 *
 * @example
 * ```typescript
 * import { isLocalRpcUrl } from "@fundable/sdk/recipes/rpc";
 *
 * isLocalRpcUrl("http://localhost:8000");   // true
 * isLocalRpcUrl("https://soroban-testnet.stellar.org"); // false
 * ```
 */
export function isLocalRpcUrl(rpcUrl: string): boolean {
  return isLoopbackHttpUrl(rpcUrl);
}