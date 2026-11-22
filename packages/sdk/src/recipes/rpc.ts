/**
 * @module @fundable/sdk
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
 * Bounded queue and concurrency limits for event consumers.
 *
 * These limits are the authoritative backpressure boundary for consumers that
 * poll or subscribe to RPC events. When the queue is full, producers must
 * either block (await capacity) or drop according to the configured overflow
 * policy; memory usage is therefore bounded by `maxQueueSize` regardless of
 * how long an RPC outage lasts.
 */
export interface EventConsumerLimits {
  /**
   * Maximum number of events buffered in memory while waiting to be
   * processed. Must be a positive integer. Bounds consumer memory during
   * RPC or downstream outages.
   */
  maxQueueSize: number;
  /**
   * Maximum number of events processed concurrently. Must be a positive
   * integer. Bounds in-flight work and RPC request pressure.
   */
  maxConcurrency: number;
  /**
   * Overflow policy applied when the queue is full:
   * - `"block"` (default): producers await capacity (natural backpressure).
   * - `"drop-oldest"`: evict the oldest buffered event to make room.
   * - `"drop-newest"`: reject the incoming event.
   */
  overflowPolicy?: "block" | "drop-oldest" | "drop-newest";
  /**
   * Maximum time in milliseconds a producer waits for capacity under the
   * `"block"` policy before failing with a timeout. Defaults to 30000.
   */
  enqueueTimeoutMs?: number;
}

/**
 * Preset event-consumer limits per network, tuned for typical RPC quotas.
 *
 * - `testnet`: generous limits; testnet RPC tolerates higher concurrency.
 * - `mainnet`: conservative limits; mainnet RPC enforces stricter quotas.
 * - `local`: small limits; local dev nodes have limited resources.
 */
export const EVENT_CONSUMER_LIMITS: Record<StellarNetwork, Required<EventConsumerLimits>> = {
  testnet: {
    maxQueueSize: 1000,
    maxConcurrency: 8,
    overflowPolicy: "block",
    enqueueTimeoutMs: 30000,
  },
  mainnet: {
    maxQueueSize: 500,
    maxConcurrency: 4,
    overflowPolicy: "block",
    enqueueTimeoutMs: 30000,
  },
  local: {
    maxQueueSize: 100,
    maxConcurrency: 2,
    overflowPolicy: "block",
    enqueueTimeoutMs: 10000,
  },
} as const;

/**
 * Validates and normalises event-consumer limits, applying network defaults
 * for any omitted fields.
 *
 * Throws if `maxQueueSize` or `maxConcurrency` is not a positive integer, or
 * if `enqueueTimeoutMs` is not a positive number. This is the authoritative
 * validation boundary for consumer backpressure configuration.
 *
 * @param network - Network identifier used to source defaults.
 * @param overrides - Optional overrides for any limit field.
 * @returns Fully resolved, validated limits.
 *
 * @example
 * ```typescript
 * import { getEventConsumerLimits } from "@fundable/sdk";
 *
 * const limits = getEventConsumerLimits("mainnet", { maxQueueSize: 250 });
 * // { maxQueueSize: 250, maxConcurrency: 4, overflowPolicy: "block", enqueueTimeoutMs: 30000 }
 * ```
 */
export function getEventConsumerLimits(
  network: StellarNetwork,
  overrides: Partial<EventConsumerLimits> = {},
): Required<EventConsumerLimits> {
  const preset = EVENT_CONSUMER_LIMITS[network];
  if (!preset) {
    throw new Error(
      `Unknown Stellar network: "${network}". ` +
        `Expected one of: ${Object.keys(EVENT_CONSUMER_LIMITS).join(", ")}`,
    );
  }

  const limits: Required<EventConsumerLimits> = { ...preset, ...overrides };

  if (!Number.isInteger(limits.maxQueueSize) || limits.maxQueueSize <= 0) {
    throw new Error(
      `Invalid maxQueueSize: ${limits.maxQueueSize}. Expected a positive integer.`,
    );
  }
  if (!Number.isInteger(limits.maxConcurrency) || limits.maxConcurrency <= 0) {
    throw new Error(
      `Invalid maxConcurrency: ${limits.maxConcurrency}. Expected a positive integer.`,
    );
  }
  if (
    limits.overflowPolicy !== "block" &&
    limits.overflowPolicy !== "drop-oldest" &&
    limits.overflowPolicy !== "drop-newest"
  ) {
    throw new Error(
      `Invalid overflowPolicy: "${limits.overflowPolicy}". ` +
        `Expected one of: block, drop-oldest, drop-newest`,
    );
  }
  if (!Number.isFinite(limits.enqueueTimeoutMs) || limits.enqueueTimeoutMs <= 0) {
    throw new Error(
      `Invalid enqueueTimeoutMs: ${limits.enqueueTimeoutMs}. Expected a positive number.`,
    );
  }

  return limits;
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
 * import { getRpcProviderConfig } from "@fundable/sdk";
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
 * import { getRpcServerOptions } from "@fundable/sdk";
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
 * import { isLocalRpcUrl } from "@fundable/sdk";
 *
 * isLocalRpcUrl("http://localhost:8000");   // true
 * isLocalRpcUrl("https://soroban-testnet.stellar.org"); // false
 * ```
 */
export function isLocalRpcUrl(rpcUrl: string): boolean {
  return isLoopbackHttpUrl(rpcUrl);
}