import type { AuditEvent } from "./event-timeline";

export type TransactionLifecycleStage =
  | "wallet_approval"
  | "submitted"
  | "ledger_confirmation"
  | "settlement";

export interface TransactionLifecycleMetadata {
  stage: TransactionLifecycleStage;
  status: "pending" | "succeeded" | "failed";
  source?: string;
  retryable?: boolean;
  failureReason?: string;
}

interface EventDetailsProps {
  event: AuditEvent;
  onClose: () => void;
  lifecycle?: TransactionLifecycleMetadata;
  onRetry?: (event: AuditEvent) => void;
  onRecover?: (event: AuditEvent) => void;
}

const STAGE_LABELS: Record<TransactionLifecycleStage, string> = {
  wallet_approval: "Wallet approval",
  submitted: "Submitted",
  ledger_confirmation: "Ledger confirmation",
  settlement: "Settlement",
};

export function EventDetails({
  event,
  onClose,
  lifecycle,
  onRetry,
  onRecover,
}: EventDetailsProps) {
  return (
    <aside className="rounded-2xl border border-white/10 bg-[#111827] p-4 text-sm text-slate-200">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">Event details</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
        >
          Close
        </button>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Action</p>
          <p className="mt-1 text-white">{event.actionType}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Title</p>
          <p className="mt-1 text-white">{event.title}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Timestamp</p>
          <p className="mt-1 text-white">{new Date(event.timestamp).toLocaleString()}</p>
        </div>
        {event.user ? (
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">User</p>
            <p className="mt-1 text-white">{event.user}</p>
          </div>
        ) : null}
        {event.resource ? (
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Resource</p>
            <p className="mt-1 text-white">{event.resource}</p>
          </div>
        ) : null}
        {event.txHash ? (
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Tx hash</p>
            <p className="mt-1 break-all text-white">{event.txHash}</p>
          </div>
        ) : null}
        {lifecycle ? (
          <>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">Lifecycle stage</p>
              <p className="mt-1 text-white">{STAGE_LABELS[lifecycle.stage]}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">Status</p>
              <p
                className={
                  lifecycle.status === "failed"
                    ? "mt-1 text-rose-300"
                    : lifecycle.status === "succeeded"
                      ? "mt-1 text-emerald-300"
                      : "mt-1 text-amber-300"
                }
              >
                {lifecycle.status}
              </p>
            </div>
            {lifecycle.source ? (
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">Source</p>
                <p className="mt-1 break-all text-white">{lifecycle.source}</p>
              </div>
            ) : null}
            {lifecycle.failureReason ? (
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">Failure reason</p>
                <p className="mt-1 text-rose-300">{lifecycle.failureReason}</p>
              </div>
            ) : null}
            {lifecycle.status === "failed" ? (
              <div className="flex gap-2 pt-2">
                {lifecycle.retryable && onRetry ? (
                  <button
                    type="button"
                    onClick={() => onRetry(event)}
                    className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                  >
                    Retry
                  </button>
                ) : null}
                {onRecover ? (
                  <button
                    type="button"
                    onClick={() => onRecover(event)}
                    className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                  >
                    Recover
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </aside>
  );
}

export const __auditEventDetailsPlaceholder = true;
