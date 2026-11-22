
export type ActionType =
  | "all"
  | "stream_created"
  | "stream_cancelled"
  | "withdrawal"
  | "payment"
  | "split"
  | "admin_change"
  | "upgrade"
  | "pause"
  | "resume";

/**
 * Retention class of an audit record. Live envelopes are the hot, indexed
 * records; archived summaries are compacted records produced by the archival
 * job. "all" queries both sources.
 */
export type RetentionClass = "all" | "live" | "archived";

/**
 * Which archive source(s) an audit query should read from. "auto" lets the
 * backend decide based on the requested date range and retention class.
 */
export type ArchiveSource = "auto" | "live" | "archive" | "both";

export interface AuditFilters {
  actionType: ActionType;
  dateRange: "7d" | "30d" | "custom";
  customStart: string;
  customEnd: string;
  search: string;
  user: string;
  resource: string;
  retentionClass: RetentionClass;
  archiveSource: ArchiveSource;
}

export const DEFAULT_FILTERS: AuditFilters = {
  actionType: "all",
  dateRange: "30d",
  customStart: "",
  customEnd: "",
  search: "",
  user: "",
  resource: "",
  retentionClass: "all",
  archiveSource: "auto",
};

interface FilterPanelProps {
  filters: AuditFilters;
  onChange: (filters: AuditFilters) => void;
  onReset: () => void;
  totalResults: number;
}

export function FilterPanel({
  filters,
  onChange,
  onReset,
  totalResults,
}: FilterPanelProps) {
  const updateField = <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) => {
    onChange({ ...filters, [key]: value });
  };

  return (
    <aside
      aria-label="Audit filters"
      className="rounded-2xl border border-white/10 bg-[#111827] p-4 text-sm text-slate-200"
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">Filters</h2>
        <span className="text-xs text-slate-400" aria-live="polite">
          {totalResults} results
        </span>
      </div>

      <div className="space-y-4">
        <div>
          <label htmlFor="audit-filter-search" className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
            Search
          </label>
          <input
            id="audit-filter-search"
            value={filters.search}
            onChange={(event) => updateField("search", event.target.value)}
            className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-fundable-purple-2"
            placeholder="Search actions"
          />
        </div>

        <div>
          <label htmlFor="audit-filter-action" className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
            Action
          </label>
          <select
            id="audit-filter-action"
            value={filters.actionType}
            onChange={(event) => updateField("actionType", event.target.value as ActionType)}
            className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-fundable-purple-2"
          >
            <option value="all">All</option>
            <option value="stream_created">stream created</option>
            <option value="stream_cancelled">stream cancelled</option>
            <option value="withdrawal">withdrawal</option>
            <option value="payment">payment</option>
            <option value="split">split</option>
            <option value="admin_change">admin change</option>
            <option value="upgrade">upgrade</option>
            <option value="pause">pause</option>
            <option value="resume">resume</option>
          </select>
        </div>

        <div>
          <label htmlFor="audit-filter-date-range" className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
            Date range
          </label>
          <select
            id="audit-filter-date-range"
            value={filters.dateRange}
            onChange={(event) => updateField("dateRange", event.target.value as AuditFilters["dateRange"])}
            className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-fundable-purple-2"
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="custom">Custom range</option>
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="audit-filter-custom-start" className="mb-1 block text-[10px] uppercase tracking-wide text-slate-400">
              From
            </label>
            <input
              id="audit-filter-custom-start"
              type="date"
              value={filters.customStart}
              onChange={(event) => updateField("customStart", event.target.value)}
              className="w-full rounded-lg border border-white/10 bg-slate-900 px-2 py-2 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-fundable-purple-2"
            />
          </div>
          <div>
            <label htmlFor="audit-filter-custom-end" className="mb-1 block text-[10px] uppercase tracking-wide text-slate-400">
              To
            </label>
            <input
              id="audit-filter-custom-end"
              type="date"
              value={filters.customEnd}
              onChange={(event) => updateField("customEnd", event.target.value)}
              className="w-full rounded-lg border border-white/10 bg-slate-900 px-2 py-2 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-fundable-purple-2"
            />
          </div>
        </div>

        <div>
          <label htmlFor="audit-filter-user" className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
            User
          </label>
          <input
            id="audit-filter-user"
            value={filters.user}
            onChange={(event) => updateField("user", event.target.value)}
            className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-fundable-purple-2"
            placeholder="alice@stellar.org"
          />
        </div>

        <div>
          <label htmlFor="audit-filter-resource" className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
            Resource
          </label>
          <input
            id="audit-filter-resource"
            value={filters.resource}
            onChange={(event) => updateField("resource", event.target.value)}
            className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-fundable-purple-2"
            placeholder="stream-..."
          />
        </div>

        <div>
          <label htmlFor="audit-filter-retention-class" className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
            Retention class
          </label>
          <select
            id="audit-filter-retention-class"
            value={filters.retentionClass}
            onChange={(event) => updateField("retentionClass", event.target.value as RetentionClass)}
            className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-fundable-purple-2"
          >
            <option value="all">All records</option>
            <option value="live">Live envelopes</option>
            <option value="archived">Archived summaries</option>
          </select>
          <p className="mt-1 text-[10px] text-slate-500">
            Archived summaries are compacted; use the reconstruction path to expand details.
          </p>
        </div>

        <div>
          <label htmlFor="audit-filter-archive-source" className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
            Archive source
          </label>
          <select
            id="audit-filter-archive-source"
            value={filters.archiveSource}
            onChange={(event) => updateField("archiveSource", event.target.value as ArchiveSource)}
            className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-fundable-purple-2"
          >
            <option value="auto">Auto</option>
            <option value="live">Live only</option>
            <option value="archive">Archive only</option>
            <option value="both">Live + archive</option>
          </select>
        </div>

        <button
          type="button"
          onClick={onReset}
          className="min-h-[36px] w-full rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fundable-purple-2 transition-colors"
        >
          Reset filters
        </button>
      </div>
    </aside>
  );
}

export type AuditFilterPanelProps = FilterPanelProps;
export const __auditFilterPanelPlaceholder = true;
