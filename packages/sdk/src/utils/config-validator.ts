/**
 * Network and Contract Configuration Validation Utilities.
 *
 * Rejects malformed IDs, mismatched network passphrases, and testnet/mainnet
 * mixups before building transactions. Supports explicit custom networks.
 */

import { StrKey, Networks } from '@stellar/stellar-sdk';
import { assertSecureRpcUrl } from './rpcConnectionOptions.js';

export interface CustomNetworkConfig {
  name: string;
  passphrase: string;
  rpcUrl: string;
  allowHttp?: boolean;
}

export interface ContractConfig {
  contractId: string;
  networkPassphrase?: string;
  rpcUrl?: string;
  customNetwork?: CustomNetworkConfig;
}

export interface TransactionConfig {
  sourceAccount: string;
  contractId?: string;
  networkPassphrase: string;
  rpcUrl?: string;
}

/**
 * Asset descriptor used for pre-launch readiness checks.
 *
 * `code` is the asset code (e.g. "XLM", "USDC"); `issuer` is required for
 * non-native assets and must be a valid Stellar account ID.
 */
export interface AssetConfig {
  code: string;
  issuer?: string;
  native?: boolean;
}

/**
 * Network readiness input for pre-launch validation.
 */
export interface NetworkReadinessConfig {
  networkPassphrase: string;
  rpcUrl?: string;
  customNetwork?: CustomNetworkConfig;
}

/**
 * Result of a single readiness check.
 */
export interface ReadinessCheckResult {
  name: string;
  passed: boolean;
  message?: string;
}

/**
 * Aggregated readiness report. `ready` is true only when every check passed.
 */
export interface ReadinessReport {
  ready: boolean;
  checks: ReadinessCheckResult[];
  failures: ReadinessCheckResult[];
}

const NATIVE_ASSET_CODE = 'XLM';
const ASSET_CODE_PATTERN = /^[A-Za-z0-9]{1,12}$/;
=======

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Validates a Stellar contract ID (StrKey C... representation).
 */
export function isValidContractId(contractId: string): boolean {
  if (typeof contractId !== 'string') return false;
  try {
    return StrKey.isValidContractId(contractId);
  } catch {
    return false;
  }
}

/**
 * Validates a Stellar account public key (StrKey G... representation).
 */
export function isValidAccountId(accountId: string): boolean {
  if (typeof accountId !== 'string') return false;
  try {
    return StrKey.isValidEd25519PublicKey(accountId);
  } catch {
    return false;
  }
}

/**
 * Validates and ensures the given contract ID is well-formed.
 */
export function assertValidContractId(contractId: string, context?: string): void {
  if (!isValidContractId(contractId)) {
    const prefix = context ? `${context}: ` : '';
    throw new ConfigurationError(
      `${prefix}Invalid contract ID "${contractId}". Must be a valid 56-character StrKey starting with 'C'.`
    );
  }
}

/**
 * Validates and ensures the given account ID is well-formed.
 */
export function assertValidAccountId(accountId: string, context?: string): void {
  if (!isValidAccountId(accountId)) {
    const prefix = context ? `${context}: ` : '';
    throw new ConfigurationError(
      `${prefix}Invalid account ID "${accountId}". Must be a valid 56-character StrKey starting with 'G'.`
    );
  }
}

/**
 * Detects mismatched RPC URLs and network passphrases (e.g. Testnet URL with Mainnet passphrase).
 */
export function assertNetworkCompatibility(rpcUrl: string, networkPassphrase: string): void {
  assertSecureRpcUrl(rpcUrl);

  const lowerUrl = rpcUrl.toLowerCase();
  const isMainnetPassphrase = networkPassphrase === Networks.PUBLIC;
  const isTestnetPassphrase = networkPassphrase === Networks.TESTNET;
  const isFuturenetPassphrase = networkPassphrase === Networks.FUTURENET;

  // URL indicates testnet, but passphrase is mainnet
  if ((lowerUrl.includes('testnet') || lowerUrl.includes('test-')) && isMainnetPassphrase) {
    throw new ConfigurationError(
      `Network mismatch: RPC URL "${rpcUrl}" appears to be a Testnet endpoint, but network passphrase is configured for Mainnet (${Networks.PUBLIC}).`
    );
  }

  // URL indicates mainnet / public, but passphrase is testnet
  if (
    (lowerUrl.includes('mainnet') || lowerUrl.includes('soroban-rpc.stellar.org')) &&
    !lowerUrl.includes('testnet') &&
    isTestnetPassphrase
  ) {
    throw new ConfigurationError(
      `Network mismatch: RPC URL "${rpcUrl}" appears to be a Mainnet endpoint, but network passphrase is configured for Testnet (${Networks.TESTNET}).`
    );
  }

  // URL indicates futurenet, but passphrase is mainnet or testnet
  if (lowerUrl.includes('futurenet') && (isMainnetPassphrase || isTestnetPassphrase)) {
    throw new ConfigurationError(
      `Network mismatch: RPC URL "${rpcUrl}" appears to be Futurenet, but passphrase is ${networkPassphrase}.`
    );
  }
}

/**
 * Validates a contract configuration object.
 */
export function validateContractConfig(config: ContractConfig): void {
  if (!config) {
    throw new ConfigurationError('Contract configuration is required');
  }

  assertValidContractId(config.contractId, 'ContractConfig');

  if (config.customNetwork) {
    if (!config.customNetwork.name || !config.customNetwork.passphrase || !config.customNetwork.rpcUrl) {
      throw new ConfigurationError(
        'CustomNetworkConfig must include "name", "passphrase", and "rpcUrl".'
      );
    }
    assertSecureRpcUrl(config.customNetwork.rpcUrl);
  }

  if (config.rpcUrl && config.networkPassphrase) {
    assertNetworkCompatibility(config.rpcUrl, config.networkPassphrase);
  }
}

/**
 * Validates a single asset descriptor for deployment readiness.
 *
 * Native assets (XLM) must not declare an issuer. Non-native assets require a
 * 1-12 character alphanumeric code and a valid Stellar issuer account.
 */
export function assertSupportedAsset(asset: AssetConfig, context?: string): void {
  const prefix = context ? `${context}: ` : '';

  if (!asset || typeof asset.code !== 'string' || asset.code.trim() === '') {
    throw new ConfigurationError(`${prefix}Asset requires a non-empty "code".`);
  }

  const isNative = asset.native === true || asset.code.toUpperCase() === NATIVE_ASSET_CODE;

  if (isNative) {
    if (asset.issuer) {
      throw new ConfigurationError(
        `${prefix}Native asset "${asset.code}" must not declare an issuer.`
      );
    }
    return;
  }

  if (!ASSET_CODE_PATTERN.test(asset.code)) {
    throw new ConfigurationError(
      `${prefix}Invalid asset code "${asset.code}". Must be 1-12 alphanumeric characters.`
    );
  }

  if (!asset.issuer) {
    throw new ConfigurationError(
      `${prefix}Non-native asset "${asset.code}" requires an issuer account.`
    );
  }

  assertValidAccountId(asset.issuer, `${prefix}Asset "${asset.code}" issuer`);
}

/**
 * Validates a list of assets, rejecting empty lists and unsupported entries.
 */
export function assertSupportedAssets(assets: AssetConfig[], context?: string): void {
  const prefix = context ? `${context}: ` : '';

  if (!Array.isArray(assets) || assets.length === 0) {
    throw new ConfigurationError(`${prefix}At least one supported asset is required.`);
  }

  const seen = new Set<string>();
  for (const asset of assets) {
    assertSupportedAsset(asset, context);
    const key = `${asset.code.toUpperCase()}:${asset.issuer ?? ''}`;
    if (seen.has(key)) {
      throw new ConfigurationError(`${prefix}Duplicate asset "${asset.code}".`);
    }
    seen.add(key);
  }
}

/**
 * Validates network readiness: passphrase presence, custom network completeness,
 * and RPC/passphrase compatibility.
 */
export function assertNetworkReady(config: NetworkReadinessConfig, context?: string): void {
  const prefix = context ? `${context}: ` : '';

  if (!config) {
    throw new ConfigurationError(`${prefix}Network configuration is required.`);
  }

  if (!config.networkPassphrase || config.networkPassphrase.trim() === '') {
    throw new ConfigurationError(`${prefix}Network requires a non-empty networkPassphrase.`);
  }

  if (config.customNetwork) {
    const { name, passphrase, rpcUrl } = config.customNetwork;
    if (!name || !passphrase || !rpcUrl) {
      throw new ConfigurationError(
        `${prefix}CustomNetworkConfig must include "name", "passphrase", and "rpcUrl".`
      );
    }
    if (passphrase !== config.networkPassphrase) {
      throw new ConfigurationError(
        `${prefix}Custom network passphrase does not match the configured networkPassphrase.`
      );
    }
    assertSecureRpcUrl(rpcUrl);
    return;
  }

  if (config.rpcUrl) {
    assertNetworkCompatibility(config.rpcUrl, config.networkPassphrase);
  }
}

/**
 * Runs all pre-launch readiness checks and returns an aggregated report
 * instead of throwing. Use this to surface every failure to operators at once.
 */
export function checkDeploymentReadiness(input: {
  network: NetworkReadinessConfig;
  assets: AssetConfig[];
  contractId?: string;
}): ReadinessReport {
  const checks: ReadinessCheckResult[] = [];

  const run = (name: string, fn: () => void): void => {
    try {
      fn();
      checks.push({ name, passed: true });
    } catch (error) {
      checks.push({
        name,
        passed: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  run('network', () => assertNetworkReady(input.network, 'Readiness'));
  run('assets', () => assertSupportedAssets(input.assets, 'Readiness'));
  if (input.contractId !== undefined) {
    run('contractId', () => assertValidContractId(input.contractId, 'Readiness'));
  }

  const failures = checks.filter((check) => !check.passed);
  return { ready: failures.length === 0, checks, failures };
}

/**
 * Throws a ConfigurationError summarizing all failed readiness checks.
 */
export function assertDeploymentReady(input: {
  network: NetworkReadinessConfig;
  assets: AssetConfig[];
  contractId?: string;
}): void {
  const report = checkDeploymentReadiness(input);
  if (!report.ready) {
    const details = report.failures
      .map((failure) => `- ${failure.name}: ${failure.message ?? 'failed'}`)
      .join('\n');
    throw new ConfigurationError(`Deployment readiness checks failed:\n${details}`);
  }
}

/**
 * Validates transaction preparation options before transaction building.
 */
export function validateTransactionConfig(config: TransactionConfig): void {
  if (!config) {
    throw new ConfigurationError('Transaction configuration is required');
  }

  assertValidAccountId(config.sourceAccount, 'TransactionConfig sourceAccount');

  if (config.contractId) {
    assertValidContractId(config.contractId, 'TransactionConfig contractId');
  }

  if (!config.networkPassphrase || config.networkPassphrase.trim() === '') {
    throw new ConfigurationError('TransactionConfig requires a non-empty networkPassphrase');
  }

  if (config.rpcUrl) {
    assertNetworkCompatibility(config.rpcUrl, config.networkPassphrase);
  }
}
