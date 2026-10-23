'use client';

import { useState, useCallback } from 'react';
import { Horizon } from '@stellar/stellar-sdk';
import { DistributorClient } from '../../../../packages/sdk/src/DistributorClient';
import { useWallet } from '@/providers/StellarWalletProvider';
import { notify } from '@/utils/notification';
import { DISTRIBUTOR_CONTRACT_ID } from '@/lib/env';
import { SOROBAN_RPC_URL, NETWORK_PASSPHRASE } from '@/lib/constants';
import { amountToStroops } from '@/utils/amount-validation';
import { getStellarServerOptions } from '@/utils/rpc-connection-options';
import {
  classifyWalletError,
  type WalletErrorAction,
  type WalletErrorClass,
} from '@/utils/wallet-error-classifier';
import type { DistributionState } from '@/types/distribution';

const IS_MAINNET = process.env.NEXT_PUBLIC_STELLAR_NETWORK === 'public';
const HORIZON_URL = IS_MAINNET
  ? 'https://horizon.stellar.org'
  : 'https://horizon-testnet.stellar.org';

const ACCOUNT_CHECK_TIMEOUT_MS = 10_000;

/**
 * Rejects after a given number of milliseconds with a timeout error.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout checking account: ${label}`)), ms)
    ),
  ]);
}

/**
 * Checks if an account exists on the Stellar network.
 * Rejects with a timeout error if the account does not respond within ACCOUNT_CHECK_TIMEOUT_MS.
 */
async function accountExists(address: string): Promise<boolean> {
  try {
    const horizon = new Horizon.Server(HORIZON_URL, getStellarServerOptions(HORIZON_URL));
    await withTimeout(horizon.loadAccount(address), ACCOUNT_CHECK_TIMEOUT_MS, address);
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Timeout checking account:')) {
      throw err;
    }
    return false;
  }
}

/**
 * Checks if the sender has a trustline for the given token and sufficient balance.
 * For native XLM, only checks balance.
 */
async function checkSenderBalance(
  senderAddress: string,
  tokenAddress: string,
  requiredAmount: bigint
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const horizon = new Horizon.Server(HORIZON_URL, getStellarServerOptions(HORIZON_URL));
    const account = await horizon.loadAccount(senderAddress);

    if (tokenAddress === 'native') {
      const xlmBalance = account.balances.find(
        (b): b is Horizon.HorizonApi.BalanceLine<'native'> => b.asset_type === 'native'
      );
      const available = xlmBalance?.balance ? amountToStroops(xlmBalance.balance) : 0n;
      // Keep 1 XLM reserve
      const reserve = 10_000_000n;
      if (available - reserve < requiredAmount) {
        return { ok: false, reason: 'Insufficient XLM balance' };
      }
      return { ok: true };
    }

    // For Soroban/SAC tokens Horizon exposes a `contract_id` field on the balance line.
    // The SDK types don't include it yet, so we extend the known union type.
    type BalanceWithContract = Horizon.HorizonApi.BalanceLine & { contract_id?: string };
    const tokenBalance = (account.balances as BalanceWithContract[]).find(
      (b) => b.asset_type !== 'native' && b.contract_id === tokenAddress
    );

    if (!tokenBalance) {
      return { ok: false, reason: 'Token trustline not found. Add the token to your wallet first.' };
    }

    const available = amountToStroops(tokenBalance.balance);
    if (available < requiredAmount) {
      return { ok: false, reason: 'Insufficient token balance' };
    }

    return { ok: true };
  } catch {
    // If we can't check, let the contract simulation catch it
    return { ok: true };
  }
}

/**
 * Recovery state surfaced to the UI after a failed submission.
 * `state` is the exact form snapshot that failed so callers can preserve
 * user input and retry without re-entering data.
 */
export interface DistributionTransactionError {
  errorClass: WalletErrorClass;
  message: string;
  action: WalletErrorAction;
  /** Form snapshot captured at submission time; never mutated. */
  state: DistributionState;
  tokenAddress: string;
}

/**
 * Hook for executing a distribution transaction against the Distributor contract.
 * Handles validation, balance checks, wallet signing, and toast notifications.
 *
 * On failure the hook classifies the error (wallet / RPC / simulation /
 * contract) and exposes a recovery action (retry, switch network, reconnect).
 * Form values are preserved via `lastError.state` so the UI can retry.
 */
export function useDistributionTransaction() {
  const { address, signTransaction, connect } = useWallet();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastError, setLastError] = useState<DistributionTransactionError | null>(null);

  const clearError = useCallback(() => setLastError(null), []);

  /**
   * Runs the recovery action associated with a classified error.
   * Returns true when the caller should retry the transaction.
   */
  const recover = useCallback(
    async (error: DistributionTransactionError): Promise<boolean> => {
      switch (error.action) {
        case 'retry':
          return true;
        case 'switch-network':
          notify.error('Switch your wallet to the correct network, then retry');
          return false;
        case 'reconnect':
          try {
            await connect();
            return true;
          } catch {
            notify.error('Reconnect failed. Please reconnect your wallet manually.');
            return false;
          }
        default:
          return false;
      }
    },
    [connect]
  );

  const execute = useCallback(
    async (state: DistributionState, tokenAddress: string): Promise<boolean> => {
      setLastError(null);

      if (!address) {
        const classified = classifyWalletError(new Error('Wallet not connected'));
        setLastError({
          errorClass: classified.errorClass,
          message: 'Connect your wallet first',
          action: 'reconnect',
          state,
          tokenAddress,
        });
        notify.error('Connect your wallet first');
        return false;
      }

      if (!state.isValid) {
        const firstError = state.errors[0]?.message ?? 'Please fix form errors before submitting';
        notify.error(firstError);
        return false;
      }

      // Filter out zero-amount entries before submission (Issue #437)
      const activeRecipients = state.recipients.filter((r) => {
        if (!r.address || r.address.trim() === '') return false;
        if (state.type === 'weighted') {
          if (!r.amount || r.amount.trim() === '') return false;
          try {
            return amountToStroops(r.amount) > 0n;
          } catch {
            return false;
          }
        }
        return true;
      });

      if (activeRecipients.length === 0) {
        notify.error('No non-zero amount recipients to process');
        return false;
      }

      const recipients = activeRecipients.map((r) => r.address);

      // Pre-flight: check all recipient accounts exist
      notify.loading('Validating recipients...');
      let existenceChecks: boolean[];
      try {
        existenceChecks = await Promise.all(recipients.map(accountExists));
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Account validation timed out';
        notify.error(msg);
        return false;
      }
      const missingIndex = existenceChecks.findIndex((exists) => !exists);
      if (missingIndex !== -1) {
        notify.error(
          `Recipient ${missingIndex + 1} (${recipients[missingIndex].slice(0, 8)}...) does not exist on the network`
        );
        return false;
      }

      // Calculate total amount in stroops (7 decimal places)
      let totalStroops: bigint;
      let amountsStroops: bigint[] = [];

      if (state.type === 'equal') {
        totalStroops = amountToStroops(state.totalAmount);
      } else {
        amountsStroops = activeRecipients.map((r) => amountToStroops(r.amount!));
        totalStroops = amountsStroops.reduce((sum, a) => sum + a, 0n);
      }

      // Pre-flight: check sender balance
      const balanceCheck = await checkSenderBalance(address, tokenAddress, totalStroops);
      if (!balanceCheck.ok) {
        notify.error(balanceCheck.reason!);
        return false;
      }

      // Check XLM balance for transaction fees
      const xlmCheck = await checkSenderBalance(address, 'native', 100000n); // 0.01 XLM for fees
      if (!xlmCheck.ok) {
        notify.error('Insufficient XLM balance for transaction fees');
        return false;
      }

      setIsSubmitting(true);
      notify.loading('Building transaction...');

      // Bind the whole simulation/signing/confirmation flow to the network
      // identity observed at the start. Any network switch aborts the flow.
      const guard = createChainBoundGuard({
        expectedNetworkPassphrase: networkPassphrase ?? NETWORK_PASSPHRASE,
        getCurrentNetworkPassphrase: () => networkPassphrase ?? NETWORK_PASSPHRASE,
      });

      try {
        const client = new DistributorClient({
          contractId: DISTRIBUTOR_CONTRACT_ID,
          networkPassphrase: NETWORK_PASSPHRASE,
          rpcUrl: SOROBAN_RPC_URL,
          publicKey: address,
        });

        let tx;
        if (state.type === 'equal') {
          tx = await client.distributeEqual({
            sender: address,
            token: tokenAddress,
            total_amount: totalStroops,
            recipients,
          });
        } else {
          tx = await client.distributeWeighted({
            sender: address,
            token: tokenAddress,
            recipients,
            amounts: amountsStroops,
          });
        }

        // Simulation is complete; ensure the network has not changed since.
        guard.assertNetworkUnchanged();

        notify.loading('Awaiting wallet signature...');

        // Wrap the wallet's signTransaction (returns string) into the shape
        // the SDK's AssembledTransaction.signAndSend expects: { signedTxXdr: string }
        const sdkSigner = async (xdr: string) => {
          // Re-check immediately before signing so a switch during the
          // simulation window cannot produce a signature on the wrong chain.
          guard.assertNetworkUnchanged();
          const signedTxXdr = await signTransaction(xdr);
          // And again after signing, before the signed envelope is broadcast.
          guard.assertNetworkUnchanged();
          return { signedTxXdr };
        };

        const sent = await tx.signAndSend({ signTransaction: sdkSigner });

        // Final check before reporting success: confirmation must belong to
        // the same chain the flow started on.
        guard.assertNetworkUnchanged();

        const txHash = sent.sendTransactionResponse?.hash ?? '';
        notify.success(
          txHash,
          `Successfully distributed to ${recipients.length} recipient${recipients.length > 1 ? 's' : ''}`
        );

        return true;
      } catch (err) {
        const classified = classifyWalletError(err);
        const failure: DistributionTransactionError = {
          errorClass: classified.errorClass,
          message: classified.message,
          action: classified.action,
          state,
          tokenAddress,
        };
        setLastError(failure);

        const retry = () => {
          void execute(state, tokenAddress);
        };

        if (classified.action === 'retry') {
          notify.error(classified.message, retry);
        } else {
          notify.error(classified.message);
        }

        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [address, signTransaction, networkPassphrase]
  );

  return { execute, isSubmitting, lastError, clearError, recover };
}
