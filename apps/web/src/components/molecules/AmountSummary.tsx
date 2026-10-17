/**
 * AmountSummary - Real-time calculation display for distribution amounts
 */

import React from 'react';
import {
  Calculator,
  Users,
  DollarSign,
  ArrowRight,
  Coins,
  FileCode2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DistributionType } from '@/types/distribution';

/**
 * Contract effect surfaced by a transaction simulation (e.g. a token
 * transfer, a stream creation, or a distribution invocation).
 */
export interface SimulationContractEffect {
  /** Contract or function identifier, e.g. `token.transfer` */
  label: string;
  /** Optional human-readable description of the effect */
  description?: string;
  /** Optional amount moved by this effect */
  amount?: string;
  /** Optional token symbol for the effect amount */
  tokenSymbol?: string;
}

/**
 * Simulation-derived review data shown before signing. All fields are
 * optional so the summary degrades gracefully when a simulation is
 * unavailable or stale.
 */
export interface SimulationSummary {
  /** Amount the transaction will move (simulation-derived) */
  amount?: string;
  /** Destination address or contract the transaction targets */
  destination?: string;
  /** Estimated network fee */
  fee?: string;
  /** Fee asset symbol (defaults to the summary token symbol) */
  feeSymbol?: string;
  /** Contract effects produced by the simulation */
  contractEffects?: SimulationContractEffect[];
  /** Whether the simulation result is stale (inputs changed since simulation) */
  isStale?: boolean;
  /** Whether the simulation failed or was rejected */
  isRejected?: boolean;
  /** Reason the simulation failed or was rejected */
  rejectionReason?: string;
}

interface AmountSummaryProps {
  /** Distribution type */
  distributionType: DistributionType;
  /** Total amount to distribute */
  totalAmount: string;
  /** Number of recipients */
  recipientCount: number;
  /** Per-recipient amount (for equal distribution) */
  perRecipientAmount?: string;
  /** Number of valid recipients with amounts (for weighted distribution) */
  validRecipientCount?: number;
  /** Token symbol to display */
  tokenSymbol?: string;
  /** Whether the summary is in a loading state */
  isLoading?: boolean;
  /** Simulation-derived review details (issue #71) */
  simulation?: SimulationSummary;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Displays real-time calculation summary for both distribution types
 */
export function AmountSummary({
  distributionType,
  totalAmount,
  recipientCount,
  perRecipientAmount,
  validRecipientCount,
  tokenSymbol = 'XLM',
  isLoading = false,
  simulation,
  className,
}: AmountSummaryProps) {
  const formatAmount = (amount: string) => {
    if (!amount || amount === '0') return '0';
    
    // Parse and format the number to remove trailing zeros
    const num = parseFloat(amount);
    if (isNaN(num)) return '0';
    
    return num.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 7,
    });
  };

  const isValidTotal = totalAmount && parseFloat(totalAmount) > 0;
  const hasRecipients = recipientCount > 0;

  const hasSimulation = Boolean(simulation);
  const simulationStale = Boolean(simulation?.isStale);
  const simulationRejected = Boolean(simulation?.isRejected);
  const simulationBlocked = simulationStale || simulationRejected;
  const contractEffects = simulation?.contractEffects ?? [];
  const feeSymbol = simulation?.feeSymbol ?? tokenSymbol;
  const simulationAmount = simulation?.amount;
  const simulationDestination = simulation?.destination;
  const simulationFee = simulation?.fee;
  const hasSimulationDetails = Boolean(
    simulationAmount || simulationDestination || simulationFee || contractEffects.length > 0
  );

  if (isLoading) {
    return (
      <div className={cn(
        'p-4 rounded-lg border border-zinc-700 bg-zinc-800/30',
        className
      )}>
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-zinc-700 rounded w-1/3"></div>
          <div className="space-y-2">
            <div className="h-3 bg-zinc-700 rounded w-1/2"></div>
            <div className="h-3 bg-zinc-700 rounded w-2/3"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      'p-4 rounded-lg border border-zinc-700 bg-zinc-800/30',
      className
    )}>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Calculator className="h-4 w-4 text-zinc-400" />
          <h3 className="text-sm font-medium text-zinc-200">
            Distribution Summary
          </h3>
        </div>

        {/* Summary Content */}
        <div className="space-y-3">
          {distributionType === 'equal' ? (
            // Equal Distribution Summary
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                  <DollarSign className="h-3 w-3" />
                  <span>Total Amount</span>
                </div>
                <span className={cn(
                  'text-sm font-mono',
                  isValidTotal ? 'text-zinc-200' : 'text-zinc-500'
                )}>
                  {formatAmount(totalAmount)} {tokenSymbol}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                  <Users className="h-3 w-3" />
                  <span>Recipients</span>
                </div>
                <span className={cn(
                  'text-sm',
                  hasRecipients ? 'text-zinc-200' : 'text-zinc-500'
                )}>
                  {recipientCount}
                </span>
              </div>

              {isValidTotal && hasRecipients && perRecipientAmount && (
                <div className="pt-2 border-t border-zinc-700">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-zinc-300">
                      Per Recipient
                    </span>
                    <span className="text-sm font-mono font-medium text-green-400">
                      {formatAmount(perRecipientAmount)} {tokenSymbol}
                    </span>
                  </div>
                </div>
              )}

              {!isValidTotal && (
                <div className="text-xs text-zinc-500 italic">
                  Enter a total amount to see per-recipient calculation
                </div>
              )}

              {!hasRecipients && (
                <div className="text-xs text-zinc-500 italic">
                  Add recipients to see distribution breakdown
                </div>
              )}
            </>
          ) : (
            // Weighted Distribution Summary
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                  <Users className="h-3 w-3" />
                  <span>Total Recipients</span>
                </div>
                <span className={cn(
                  'text-sm',
                  hasRecipients ? 'text-zinc-200' : 'text-zinc-500'
                )}>
                  {recipientCount}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                  <Calculator className="h-3 w-3" />
                  <span>With Amounts</span>
                </div>
                <span className={cn(
                  'text-sm',
                  (validRecipientCount || 0) > 0 ? 'text-zinc-200' : 'text-zinc-500'
                )}>
                  {validRecipientCount || 0}
                </span>
              </div>

              <div className="pt-2 border-t border-zinc-700">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm text-zinc-400">
                    <DollarSign className="h-3 w-3" />
                    <span className="font-medium text-zinc-300">Total Amount</span>
                  </div>
                  <span className={cn(
                    'text-sm font-mono font-medium',
                    isValidTotal ? 'text-green-400' : 'text-zinc-500'
                  )}>
                    {formatAmount(totalAmount)} {tokenSymbol}
                  </span>
                </div>
              </div>

              {!hasRecipients && (
                <div className="text-xs text-zinc-500 italic">
                  Add recipients with amounts to see total calculation
                </div>
              )}

              {hasRecipients && (!validRecipientCount || validRecipientCount === 0) && (
                <div className="text-xs text-zinc-500 italic">
                  Enter amounts for recipients to see total calculation
                </div>
              )}
            </>
          )}
        </div>

        {/* Simulation Review (issue #71) */}
        {hasSimulation && (
          <div
            className="pt-3 border-t border-zinc-700 space-y-3"
            data-testid="simulation-review"
          >
            <div className="flex items-center gap-2">
              <FileCode2 className="h-4 w-4 text-zinc-400" />
              <h4 className="text-sm font-medium text-zinc-200">
                Simulation Preview
              </h4>
            </div>

            {hasSimulationDetails ? (
              <div className="space-y-2">
                {simulationAmount && (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm text-zinc-400">
                      <Coins className="h-3 w-3" />
                      <span>Amount</span>
                    </div>
                    <span className="text-sm font-mono text-zinc-200">
                      {formatAmount(simulationAmount)} {tokenSymbol}
                    </span>
                  </div>
                )}

                {simulationDestination && (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm text-zinc-400">
                      <ArrowRight className="h-3 w-3" />
                      <span>Destination</span>
                    </div>
                    <span
                      className="text-sm font-mono text-zinc-200 truncate max-w-[60%]"
                      title={simulationDestination}
                    >
                      {simulationDestination}
                    </span>
                  </div>
                )}

                {simulationFee && (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm text-zinc-400">
                      <DollarSign className="h-3 w-3" />
                      <span>Estimated Fee</span>
                    </div>
                    <span className="text-sm font-mono text-zinc-200">
                      {formatAmount(simulationFee)} {feeSymbol}
                    </span>
                  </div>
                )}

                {contractEffects.length > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm text-zinc-400">
                      <FileCode2 className="h-3 w-3" />
                      <span>Contract Effects</span>
                    </div>
                    <ul className="space-y-1 pl-5">
                      {contractEffects.map((effect, index) => (
                        <li
                          key={`${effect.label}-${index}`}
                          className="flex items-center justify-between gap-3 text-xs"
                        >
                          <span className="text-zinc-300">
                            {effect.label}
                            {effect.description && (
                              <span className="text-zinc-500"> — {effect.description}</span>
                            )}
                          </span>
                          {effect.amount && (
                            <span className="font-mono text-zinc-200">
                              {formatAmount(effect.amount)} {effect.tokenSymbol ?? tokenSymbol}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-zinc-500 italic">
                No simulation details available yet
              </div>
            )}

            {simulationRejected && (
              <div
                className="flex items-start gap-2 text-xs text-red-400"
                data-testid="simulation-rejected"
              >
                <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                <span>
                  Simulation rejected
                  {simulation?.rejectionReason ? `: ${simulation.rejectionReason}` : ''}
                </span>
              </div>
            )}

            {!simulationRejected && simulationStale && (
              <div
                className="flex items-start gap-2 text-xs text-yellow-400"
                data-testid="simulation-stale"
              >
                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                <span>
                  Simulation is stale — re-run it before signing
                </span>
              </div>
            )}
          </div>
        )}

        {/* Status Indicators */}
        {isValidTotal && hasRecipients && !simulationBlocked && (
          <div className="pt-3 border-t border-zinc-700">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-green-400"></div>
              <span className="text-xs text-green-400">
                Ready for distribution
              </span>
            </div>
          </div>
        )}

        {isValidTotal && hasRecipients && simulationBlocked && (
          <div className="pt-3 border-t border-zinc-700">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-red-400"></div>
              <span className="text-xs text-red-400">
                {simulationRejected
                  ? 'Simulation rejected — review before signing'
                  : 'Simulation stale — re-run before signing'}
              </span>
            </div>
          </div>
        )}

        {(!isValidTotal || !hasRecipients) && (
          <div className="pt-3 border-t border-zinc-700">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-yellow-400"></div>
              <span className="text-xs text-yellow-400">
                {!hasRecipients ? 'Add recipients' : 'Set amounts'} to continue
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}