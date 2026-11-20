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
  /**
   * Indicates where the event detail originates. `live` events are backed by a
   * full raw envelope; `archived` events have had their raw rows compacted and
   * their detail is reconstructed from an archived summary. Archived events may
   * omit `before`/`after` payloads.
   */
  source?: "live" | "archived";
  /** Timestamp at which the raw envelope was compacted into the archive. */
  archivedAt?: string;
};

interface EventTimelineProps {
  events: AuditEvent[];
  selectedId: string | null;
  onSelect: (event: AuditEvent) => void;
  page: number;
  pageSize: number;
}

function isArchived(event: AuditEvent): boolean {
  return event.source === "archived";
}

export function EventTimeline({ events, selectedId, onSelect, page, pageSize }: EventTimelineProps) {
  // Pagination is applied over the full event list so that archived (compacted)
  // rows keep their stable position relative to live rows.
  const start = (page - 1) * pageSize;
  const visible = events.slice(start, start + pageSize);
  const archivedCount = events.reduce((count, event) => (isArchived(event) ? count + 1 : count), 0);

  return (
    <div className="rounded-2xl border border-white/10 bg-[#111827] p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">Event timeline</h2>
        <span className="text-xs text-slate-400">
          {events.length} events
          {archivedCount > 0 ? ` · ${archivedCount} archived` : ""}
        </span>
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
              <div className="flex flex-col items-end gap-1">
                <span className="text-[10px] uppercase tracking-wide text-slate-400">
                  {new Date(event.timestamp).toLocaleDateString()}
                </span>
                {isArchived(event) ? (
                  <span
                    className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300"
                    title={
                      event.archivedAt
                        ? `Raw rows compacted on ${new Date(event.archivedAt).toLocaleString()}; detail reconstructed from archived summary.`
                        : "Raw rows compacted; detail reconstructed from archived summary."
                    }
                  >
                    Archived
                  </span>
                ) : (
                  <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
                    Live
                  </span>
                )}
              </div>
            </div>
            {event.description ? <p className="mt-2 text-xs text-slate-300">{event.description}</p> : null}
            {isArchived(event) ? (
              <p className="mt-2 text-[10px] text-amber-300/80">
                Detail reconstructed from archived summary; raw envelope no longer available.
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-400">
              {event.user ? <span>User: {event.user}</span> : null}
              {event.resource ? <span>Resource: {event.resource}</span> : null}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export const __auditEventTimelinePlaceholder = true;
