"use client";

import { TokenBalanceList } from "@/components/token-balance";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ErrorFallback } from "@/components/ui/error-fallback";
import { TransactionTimeline } from "@/components/transaction-timeline";

export default function BalancesPage() {
  return (
    <div className="min-h-screen bg-zinc-950 py-12 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Page Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-zinc-50 mb-2">
            Token Balances
          </h1>
          <p className="text-zinc-400">
            View all your Stellar token balances in one place
          </p>
        </div>

        <ErrorBoundary
          boundaryName="token-balances-module"
          fallback={({ error, reset }) => (
            <ErrorFallback
              title="Token Balances Unavailable"
              description="We couldn't render the balances section."
              error={error}
              onRetry={reset}
              className="max-w-2xl"
            />
          )}
        >
          <TokenBalanceList className="max-w-2xl" />
        </ErrorBoundary>

        {/* Transaction confirmation timeline for recent balance-affecting transactions */}
        <div className="mt-12">
          <div className="mb-4">
            <h2 className="text-xl font-semibold text-zinc-50 mb-1">
              Recent Transactions
            </h2>
            <p className="text-sm text-zinc-400">
              Track wallet approval, submission, ledger confirmation, and
              settlement for transactions that affect your balances.
            </p>
          </div>

          <ErrorBoundary
            boundaryName="transaction-timeline-module"
            fallback={({ error, reset }) => (
              <ErrorFallback
                title="Transaction Timeline Unavailable"
                description="We couldn't render the transaction confirmation timeline."
                error={error}
                onRetry={reset}
                className="max-w-2xl"
              />
            )}
          >
            <TransactionTimeline className="max-w-2xl" />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}