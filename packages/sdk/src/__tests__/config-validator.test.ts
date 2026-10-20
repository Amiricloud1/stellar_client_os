import { describe, it, expect } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import {
  isValidContractId,
  isValidAccountId,
  assertValidContractId,
  assertValidAccountId,
  assertNetworkCompatibility,
  validateContractConfig,
  validateTransactionConfig,
  ConfigurationError,
} from '../utils/config-validator.js';

describe('Configuration Validator', () => {
  const validContractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const validAccountId = 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GIOVPVUIV255KZG42CA5';

  describe('ID validations', () => {
    it('validates correct contract and account IDs', () => {
      expect(isValidContractId(validContractId)).toBe(true);
      expect(isValidAccountId(validAccountId)).toBe(true);
    });

    it('rejects malformed contract IDs', () => {
      expect(isValidContractId('not_a_contract_id')).toBe(false);
      expect(isValidContractId(validAccountId)).toBe(false); // Account key passed as contract ID
      expect(() => assertValidContractId('invalid')).toThrow(ConfigurationError);
    });

    it('rejects malformed account IDs', () => {
      expect(isValidAccountId('not_an_account_id')).toBe(false);
      expect(isValidAccountId(validContractId)).toBe(false); // Contract key passed as account ID
      expect(() => assertValidAccountId('invalid')).toThrow(ConfigurationError);
    });
  });

  describe('Network Compatibility checks', () => {
    it('allows matching testnet RPC and passphrase', () => {
      expect(() =>
        assertNetworkCompatibility(
          'https://soroban-testnet.stellar.org',
          Networks.TESTNET
        )
      ).not.toThrow();
    });

    it('allows matching mainnet RPC and passphrase', () => {
      expect(() =>
        assertNetworkCompatibility(
          'https://soroban-rpc.stellar.org',
          Networks.PUBLIC
        )
      ).not.toThrow();
    });

    it('rejects testnet URL with mainnet passphrase', () => {
      expect(() =>
        assertNetworkCompatibility(
          'https://soroban-testnet.stellar.org',
          Networks.PUBLIC
        )
      ).toThrow(/Network mismatch: RPC URL .* appears to be a Testnet endpoint/);
    });

    it('rejects mainnet URL with testnet passphrase', () => {
      expect(() =>
        assertNetworkCompatibility(
          'https://mainnet.soroban.example/rpc',
          Networks.TESTNET
        )
      ).toThrow(/Network mismatch: RPC URL .* appears to be a Mainnet endpoint/);
    });
  });

  describe('validateContractConfig', () => {
    it('validates valid contract configuration', () => {
      expect(() =>
        validateContractConfig({
          contractId: validContractId,
          rpcUrl: 'https://soroban-testnet.stellar.org',
          networkPassphrase: Networks.TESTNET,
        })
      ).not.toThrow();
    });

    it('supports custom networks', () => {
      expect(() =>
        validateContractConfig({
          contractId: validContractId,
          customNetwork: {
            name: 'Local Sandbox',
            passphrase: 'Local Sandbox Network ; 2026',
            rpcUrl: 'http://localhost:8000',
            allowHttp: true,
          },
        })
      ).not.toThrow();
    });
  });

  describe('validateTransactionConfig', () => {
    it('validates complete transaction config', () => {
      expect(() =>
        validateTransactionConfig({
          sourceAccount: validAccountId,
          contractId: validContractId,
          networkPassphrase: Networks.TESTNET,
          rpcUrl: 'https://soroban-testnet.stellar.org',
        })
      ).not.toThrow();
    });

    it('rejects invalid source account', () => {
      expect(() =>
        validateTransactionConfig({
          sourceAccount: 'invalid_source',
          networkPassphrase: Networks.TESTNET,
        })
      ).toThrow(/Invalid account ID/);
    });
  });
});
