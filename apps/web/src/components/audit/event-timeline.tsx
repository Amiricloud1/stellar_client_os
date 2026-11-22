import type { ReactNode } from "react";

export type AuditEvent = {
  id: string;
  actionType: string;
  title: string;
  description?: string;
  timestamp: string;
  user?: string;
  resource?: string;
  txHash?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

/**
 * Stages of a transaction confirmation timeline. These are intentionally
 * distinct so users can tell wallet approval apart from submission, ledger
 * confirmation and final settlement.
 */
export type TransactionStage =
  | "wallet_approval"
  | "submission"
  | "ledger_confirmation"
  | "settlement";

export type TransactionStageStatus =
  | "pending"
  | "in_progress"
  | "succeeded"
  | "failed"
  | "recovered";

export type TransactionStageEntry = {
  stage: TransactionStage;
  status: TransactionStageStatus;
  /** ISO timestamp of the last status transition for this stage. */
  timestamp?: string;
  /** Human readable detail, e.g. failure reason or recovery note. */
  detail?: string;
  /** Whether this entry was rehydrated from persisted state after a reload. */
  rehydrated?: boolean;
};

export type TransactionTimeline = {
  id: string;
  txHash?: string;
  stages: TransactionStageEntry[];
  /** Set when the whole transaction failed and needs operator/user action. */
  failure?: {
    stage: TransactionStage;
    message: string;
    recoverable: boolean;
  };
  /** True when the timeline was restored from persisted state after reload. */
  rehydrated?: boolean;
  /** True when a retry/recovery is currently in progress. */
  recovering?: boolean;
};

const STAGE_ORDER: TransactionStage[] = [
  "wallet_approval",
  "submission",
  "ledger_confirmation",
  "settlement",
];

const STAGE_LABELS: Record<TransactionStage, string> = {
  wallet_approval: "Wallet approval",
  submission: "Submission",
  ledger_confirmation: "Ledger confirmation",
  settlement: "Settlement",
};

const STATUS_LABELS: Record<TransactionStageStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  succeeded: "Confirmed",
  failed: "Failed",
  recovered: "Recovered",
};

const STATUS_STYLES: Record<TransactionStageStatus, string> = {
  pending: "border-white/10 bg-slate-900/80 text-slate-400",
  in_progress: "border-sky-500/60 bg-sky-500/10 text-sky-300",
  succeeded: "border-emerald-500/60 bg-emerald-500/10 text-emerald-300",
  failed: "border-rose-500/60 bg-rose-500/10 text-rose-300",
  recovered: "border-amber-500/60 bg-amber-500/10 text-amber-300",
};

function normalizeStages(stages: TransactionStageEntry[]): TransactionStageEntry[] {
  const byStage = new Map<TransactionStage, TransactionStageEntry>();
  for (const entry of stages) {
    byStage.set(entry.stage, entry);
  }
  return STAGE_ORDER.map(
    (stage) => byStage.get(stage) ?? { stage, status: "pending" as const },
  );
}

interface TransactionTimelineProps {
  timeline: TransactionTimeline;
  onRetry?: (timeline: TransactionTimeline) => void;
}

export function TransactionConfirmationTimeline({ timeline, onRetry }: TransactionTimelineProps) {
  const stages = normalizeStages(timeline.stages);
  const failure = timeline.failure;

  return (
    <div
      className="rounded-2xl border border-white/10 bg-[#111827] p-4"
      data-testid="transaction-timeline"
      data-tx-id={timeline.id}
      data-rehydrated={timeline.rehydrated ? "true" : "false"}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-white">Transaction confirmation</h2>
        <div className="flex items-center gap-2">
          {timeline.rehydrated ? (
            <span className="rounded-full border border-amber-500/60 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
              Restored after reload
            </span>
          ) : null}
          {timeline.txHash ? (
            <span className="font-mono text-[10px] text-slate-400">{timeline.txHash}</span>
          ) : null}
        </div>
      </div>

      <ol className="space-y-2">
        {stages.map((entry, index) => (
          <li
            key={entry.stage}
            data-testid={`transaction-stage-${entry.stage}`}
            data-status={entry.status}
            className={`flex items-start justify-between gap-3 rounded-xl border p-3 ${STATUS_STYLES[entry.status]}`}
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current text-[10px]">
                {index + 1}
              </span>
              <div>
                <p className="text-sm font-medium text-white">{STAGE_LABELS[entry.stage]}</p>
                <p className="mt-1 text-xs">{STATUS_LABELS[entry.status]}</p>
                {entry.detail ? <p className="mt-1 text-[11px] opacity-80">{entry.detail}</p> : null}
                {entry.rehydrated ? (
                  <p className="mt-1 text-[10px] uppercase tracking-wide opacity-80">Rehydrated</p>
                ) : null}
              </div>
            </div>
            {entry.timestamp ? (
              <span className="text-[10px] uppercase tracking-wide opacity-80">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      {failure ? (
        <div
          role="alert"
          data-testid="transaction-failure"
          className="mt-4 rounded-xl border border-rose-500/60 bg-rose-500/10 p-3 text-xs text-rose-200"
        >
          <p className="font-medium text-rose-100">
            {STAGE_LABELS[failure.stage]} failed
          </p>
          <p className="mt-1">{failure.message}</p>
          {failure.recoverable ? (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => onRetry?.(timeline)}
                disabled={timeline.recovering}
                className="rounded-lg border border-rose-400/60 bg-rose-500/20 px-2 py-1 text-[11px] font-medium text-rose-100 disabled:opacity-50"
              >
                {timeline.recovering ? "Recovering…" : "Retry"}
              </button>
              <span className="text-[10px] text-rose-200/80">
                You can safely retry; the transaction will not be double-submitted.
              </span>
            </div>
          ) : (
            <p className="mt-2 text-[10px] text-rose-200/80">
              This failure requires operator intervention and cannot be retried automatically.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface EventTimelineProps {
  events: AuditEvent[];
  selectedId: string | null;
  onSelect: (event: AuditEvent) => void;
  page: number;
  pageSize: number;
  /** Optional transaction confirmation timeline rendered above the audit events. */
  transaction?: TransactionTimeline;
  onRetryTransaction?: (timeline: TransactionTimeline) => void;
}

export function EventTimeline({
  events,
  selectedId,
  onSelect,
  page,
  pageSize,
  transaction,
  onRetryTransaction,
}: EventTimelineProps) {
  const start = (page - 1) * pageSize;
  const visible = events.slice(start, start + pageSize);

  return (
    <div className="space-y-4">
      {transaction ? (
        <TransactionConfirmationTimeline timeline={transaction} onRetry={onRetryTransaction} />
      ) : null}

      <div className="rounded-2xl border border-white/10 bg-[#111827] p-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Event timeline</h2>
          <span className="text-xs text-slate-400">{events.length} events</span>
        </div>

        <div className="space-y-3">
          {visible.map((event) => (
            <button
              key={event.id}
              type="button"
              onClick={() => onSelect(event)}
              className={`w-full rounded-xl border p-3 text-left transition-colors ${
                selectedId === event.id
                  ? "border-violet-500/60 bg-violet-500/10"
                  : "border-white/10 bg-slate-900/80 hover:border-white/20 hover:bg-slate-900"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-white">{event.title}</p>
                  <p className="mt-1 text-xs text-slate-400">{event.actionType}</p>
                </div>
                <span className="text-[10px] uppercase tracking-wide text-slate-400">
                  {new Date(event.timestamp).toLocaleDateString()}
                </span>
              </div>
              {event.description ? <p className="mt-2 text-xs text-slate-300">{event.description}</p> : null}
              <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-400">
                {event.user ? <span>User: {event.user}</span> : null}
                {event.resource ? <span>Resource: {event.resource}</span> : null}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export const __auditEventTimelinePlaceholder = true;
