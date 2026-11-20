import type { AuditEvent } from "./event-timeline";

export type EnvelopeRetentionClass = "full" | "compact" | "purged";

export interface AuditEnvelopeLinkage {
  envelopeId: string;
  payloadHash: string;
  retentionClass: EnvelopeRetentionClass;
  privacyFlags: string[];
  archivedSummaryUrl?: string;
}

export type AuditEventWithEnvelope = AuditEvent & {
  envelope?: AuditEnvelopeLinkage | null;
};

interface EventDetailsProps {
  event: AuditEventWithEnvelope;
  onClose: () => void;
}

function EnvelopeSection({ envelope }: { envelope?: AuditEnvelopeLinkage | null }) {
  if (!envelope) {
    return (
      <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3">
        <p className="text-xs uppercase tracking-wide text-amber-300">Raw envelope</p>
        <p className="mt-1 text-amber-200">
          Envelope unavailable. No raw envelope is linked to this event, so its integrity cannot be
          verified from source.
        </p>
      </div>
    );
  }

  const isUnavailable = envelope.retentionClass === "purged";

  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-slate-900/60 p-3">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-400">Envelope id</p>
        <p className="mt-1 break-all text-white">{envelope.envelopeId}</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-400">Payload hash</p>
        <p className="mt-1 break-all font-mono text-xs text-white">{envelope.payloadHash}</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-400">Retention class</p>
        <p className="mt-1 text-white">{envelope.retentionClass}</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-400">Privacy flags</p>
        {envelope.privacyFlags.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-1">
            {envelope.privacyFlags.map((flag) => (
              <li
                key={flag}
                className="rounded-full border border-white/10 bg-slate-800 px-2 py-0.5 text-xs text-slate-200"
              >
                {flag}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-slate-400">None</p>
        )}
      </div>

      {isUnavailable ? (
        <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-300">
            Envelope unavailable / expired
          </p>
          <p className="mt-1 text-amber-200">
            The raw envelope has been purged or compacted under the retention policy. Integrity can
            only be checked against the archived summary.
          </p>
          {envelope.archivedSummaryUrl ? (
            <a
              href={envelope.archivedSummaryUrl}
              className="mt-2 inline-block text-xs text-sky-300 underline hover:text-sky-200"
            >
              View archived summary
            </a>
          ) : (
            <p className="mt-2 text-xs text-amber-300">
              No archived summary is available for this envelope.
            </p>
          )}
        </div>
      ) : envelope.retentionClass === "compact" && envelope.archivedSummaryUrl ? (
        <a
          href={envelope.archivedSummaryUrl}
          className="inline-block text-xs text-sky-300 underline hover:text-sky-200"
        >
          View archived summary
        </a>
      ) : null}
    </div>
  );
}

export function EventDetails({ event, onClose }: EventDetailsProps) {
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
        <div>
          <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">Source envelope</p>
          <EnvelopeSection envelope={event.envelope} />
        </div>
      </div>
    </aside>
  );
}

export const __auditEventDetailsPlaceholder = true;
