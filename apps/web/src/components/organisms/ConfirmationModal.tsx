'use client';

import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { SimulationReview } from './SimulationReview';
import { Button } from '@/components/ui/button';
import { TransactionSummary } from '@/types/distribution';

/**
 * Chain identity captured when the transaction flow started (simulation time).
 * The confirmation is only valid for this exact network.
 */
export interface ChainIdentity {
  network: string;
  networkPassphrase: string;
}

interface ConfirmationModalProps {
  isOpen: boolean;
  summary: TransactionSummary;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading?: boolean;
  /** Chain identity captured when the flow began (simulation/signing). */
  capturedChain?: ChainIdentity | null;
  /** Chain identity currently selected in the wallet/app. */
  currentChain?: ChainIdentity | null;
  /**
   * True when the network changed after the flow started and the user has not
   * yet re-confirmed. Confirmation stays blocked until the flow is restarted.
   */
  requiresRenewedConfirmation?: boolean;
}

const chainLabel = (chain?: ChainIdentity | null): string =>
  chain ? `${chain.network} (${chain.networkPassphrase})` : 'Unknown network';

export const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  isOpen,
  summary,
  onConfirm,
  onCancel,
  isLoading = false,
  capturedChain = null,
  currentChain = null,
  requiresRenewedConfirmation = false,
}) => {
  const chainMismatch =
    !!capturedChain &&
    !!currentChain &&
    (capturedChain.network !== currentChain.network ||
      capturedChain.networkPassphrase !== currentChain.networkPassphrase);

  const isBlocked = chainMismatch || requiresRenewedConfirmation;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Confirm Distribution</DialogTitle>
          <DialogDescription>Please review the distribution details before confirming.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {summary.simulation && (
            <SimulationReview simulation={summary.simulation} />
          )}
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-zinc-400">Type:</span>
              <span className="text-zinc-100 capitalize">{summary.type}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">Recipients:</span>
              <span className="text-zinc-100">{summary.recipientCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">Total Amount:</span>
              <span className="text-zinc-100">{summary.totalAmount} {summary.tokenSymbol}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">Estimated Fee:</span>
              <span className="text-zinc-100">{summary.estimatedFee} XLM</span>
            </div>
            <div className="flex justify-between" data-testid="confirmation-chain">
              <span className="text-zinc-400">Network:</span>
              <span className="text-zinc-100">{chainLabel(capturedChain)}</span>
            </div>
          </div>

          {isBlocked && (
            <div
              role="alert"
              data-testid="chain-mismatch-warning"
              className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300"
            >
              {chainMismatch ? (
                <>
                  The network changed after this transaction was prepared. Prepared on{' '}
                  <strong>{chainLabel(capturedChain)}</strong>, but the wallet is now on{' '}
                  <strong>{chainLabel(currentChain)}</strong>. Cancel and restart the flow to
                  prepare a new transaction for the current network.
                </>
              ) : (
                <>
                  The network changed since this transaction was prepared. Renewed confirmation
                  is required: cancel and restart the flow to review a fresh simulation.
                </>
              )}
            </div>
          )}

          <div className="text-xs text-zinc-500">
            This action cannot be undone. Please ensure all details are correct.
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isLoading || isBlocked}
          >
            {isLoading ? 'Processing...' : 'Confirm Distribution'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
