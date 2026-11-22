'use client';

import React, { useState, useCallback, useRef } from 'react';
import { Button } from './button';
import { AlertCircle, RefreshCw, Inbox, AlertTriangle } from 'lucide-react';

export type DataStatus = 'idle' | 'loading' | 'empty' | 'unavailable' | 'stale' | 'ready';

export interface AsyncStateViewProps {
  status: DataStatus;
  emptyTitle?: string;
  emptyDescription?: string;
  unavailableTitle?: string;
  unavailableDescription?: string;
  errorMessage?: string;
  onRetry?: () => Promise<void> | void;
  onClearFilters?: () => void;
  isFinancialMutation?: boolean;
  mutationIdempotencyKey?: string;
  children?: React.ReactNode;
}

/**
 * Ensures distinct representations between valid empty results ("no-data")
 * and upstream errors or network outages ("unavailable data"), while guarding
 * financial retry actions against duplicate mutations via idempotency keys.
 */
export function AsyncStateView({
  status,
  emptyTitle = 'No records found',
  emptyDescription = 'There are no items to display matching the current criteria.',
  unavailableTitle = 'Data currently unavailable',
  unavailableDescription = 'Unable to fetch real-time state from the network or ledger.',
  errorMessage,
  onRetry,
  onClearFilters,
  isFinancialMutation = false,
  mutationIdempotencyKey,
  children
}: AsyncStateViewProps) {
  const [isRetrying, setIsRetrying] = useState(false);
  const executedKeys = useRef<Set<string>>(new Set());

  const handleRetry = useCallback(async () => {
    if (!onRetry || isRetrying) return;

    if (isFinancialMutation && mutationIdempotencyKey) {
      if (executedKeys.current.has(mutationIdempotencyKey)) {
        console.warn(
          `[AsyncStateView] Duplicate financial mutation prevented for key: ${mutationIdempotencyKey}`
        );
        return;
      }
      executedKeys.current.add(mutationIdempotencyKey);
    }

    try {
      setIsRetrying(true);
      await onRetry();
    } finally {
      setIsRetrying(false);
    }
  }, [onRetry, isRetrying, isFinancialMutation, mutationIdempotencyKey]);

  if (status === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center text-zinc-400">
        <RefreshCw className="h-8 w-8 animate-spin mb-3 text-emerald-500" />
        <p className="text-sm">Loading authoritative data...</p>
      </div>
    );
  }

  if (status === 'empty') {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center rounded-lg border border-dashed border-zinc-700 bg-zinc-900/40">
        <Inbox className="h-10 w-10 text-zinc-500 mb-3" />
        <h3 className="text-base font-semibold text-zinc-200">{emptyTitle}</h3>
        <p className="text-sm text-zinc-400 mt-1 max-w-sm">{emptyDescription}</p>
        {onClearFilters && (
          <Button variant="outline" size="sm" onClick={onClearFilters} className="mt-4">
            Reset Filters
          </Button>
        )}
      </div>
    );
  }

  if (status === 'unavailable') {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center rounded-lg border border-red-900/50 bg-red-950/20 text-red-200">
        <AlertCircle className="h-10 w-10 text-red-400 mb-3" />
        <h3 className="text-base font-semibold text-red-100">{unavailableTitle}</h3>
        <p className="text-sm text-red-300 mt-1 max-w-sm">
          {errorMessage || unavailableDescription}
        </p>
        {onRetry && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRetry}
            disabled={isRetrying}
            className="mt-4 border-red-700 text-red-100 hover:bg-red-900/40"
          >
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
            {isRetrying ? 'Retrying...' : 'Retry Request'}
          </Button>
        )}
      </div>
    );
  }

  return (
    <>
      {status === 'stale' && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-800/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
          <span>Showing cached state. Live network sync is temporarily delayed.</span>
        </div>
      )}
      {children}
    </>
  );
}

/**
 * Creates an idempotent executor for financial actions to prevent duplicate mutations.
 */
export function createIdempotentMutationGuard() {
  const executedActions = new Set<string>();

  return async function executeIdempotent<T>(
    idempotencyKey: string,
    action: () => Promise<T>
  ): Promise<T> {
    if (executedActions.has(idempotencyKey)) {
      throw new Error(`Duplicate mutation rejected for idempotency key: ${idempotencyKey}`);
    }
    executedActions.add(idempotencyKey);
    try {
      return await action();
    } catch (err) {
      executedActions.delete(idempotencyKey); // Allow retry on failure
      throw err;
    }
  };
}
