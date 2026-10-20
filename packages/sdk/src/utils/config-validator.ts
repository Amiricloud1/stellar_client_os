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
