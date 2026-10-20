"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  Leaf,
  RefreshCw,
  ShieldAlert,
  Sprout,
  Target,
  Users,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type {
  AnalyticsAuthorityReport,
  AnalyticsMetricDefinition,
  AnalyticsMetricKey,
} from "@/lib/analytics-authority";
import { ANALYTICS_METRIC_DEFINITIONS } from "@/lib/analytics-authority";

export interface DashboardData {
  updatedAt: number;
  currencyUnit: "stroops";
  metrics: {
    activeCampaigns: number;
    totalTreesPlanted: number;
    totalCo2SequesteredKg: number;
    totalSponsors: number;
    sponsorGrowthPercent: number;
    campaignCompletionRate: number;
    revenue: string;
  };
  monthlyTrend: Array<{ month: string; campaigns: number; sponsors: number; revenue: string }>;
  authority?: AnalyticsAuthorityReport;
  metricDefinitions?: Record<AnalyticsMetricKey, AnalyticsMetricDefinition>;
}

const formatNumber = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);

function formatRevenue(value: string): string {
  return `${formatNumber(Number(value) / 10_000_000)} XLM`;
}

function formatAgeSeconds(ageMs: number | null): string {
  if (ageMs === null || Number.isNaN(ageMs)) return "Unknown age";
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}

function AuthorityBanner({ authority }: { authority?: AnalyticsAuthorityReport }) {
  const resolved: AnalyticsAuthorityReport = authority ?? {
    state: "unavailable",
    isAuthoritative: false,
    isFresh: false,
    ledgerSequence: null,
    ledgerClosedAt: null,
    checkedAt: Date.now(),
    stalenessMs: null,
    maxStalenessMs: 300_000,
    reason: "missing_authority",
    message: "Authoritative ledger state is unavailable; metrics cannot be verified against on-chain state.",
    discrepancies: [],
  };

  if (resolved.state === "fresh") {
    return (
      <section
        data-testid="analytics-authority-banner"
        data-authority-status="fresh"
        role="status"
        aria-live="polite"
        className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200"
      >
        <div className="flex items-center gap-2.5">
          <CheckCircle2 size={18} className="shrink-0 text-emerald-400" />
          <span>
            Verified against authoritative ledger{" "}
            <strong className="font-semibold text-white">#{resolved.ledgerSequence}</strong>
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-emerald-300/90">
          <span data-testid="analytics-freshness-badge">
            Fresh · {formatAgeSeconds(resolved.stalenessMs)}
          </span>
        </div>
      </section>
    );
  }

  if (resolved.state === "stale") {
    return (
      <section
        data-testid="analytics-authority-banner"
        data-authority-status="stale"
        role="status"
        aria-live="polite"
        className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
      >
        <div className="flex items-center gap-2.5">
          <Clock size={18} className="shrink-0 text-amber-400" />
          <span>
            Stale ledger authority{" "}
            {resolved.ledgerSequence ? (
              <strong className="font-semibold text-white">(#{resolved.ledgerSequence})</strong>
            ) : null}{" "}
            — authoritative snapshot exceeds freshness window.
          </span>
        </div>
        <span data-testid="analytics-freshness-badge" className="text-xs text-amber-300">
          Stale · {formatAgeSeconds(resolved.stalenessMs)}
        </span>
      </section>
    );
  }

  if (resolved.state === "mismatch") {
    return (
      <section
        data-testid="analytics-authority-banner"
        data-authority-status="mismatch"
        role="alert"
        className="mb-6 flex flex-col gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <ShieldAlert size={18} className="shrink-0 text-rose-400" />
            <span>
              Ledger discrepancy detected against authoritative ledger{" "}
              {resolved.ledgerSequence ? `#${resolved.ledgerSequence}` : ""}
            </span>
          </div>
          <span data-testid="analytics-freshness-badge" className="text-xs text-rose-300">
            Unverified · {resolved.discrepancies.length} metric mismatch(es)
          </span>
        </div>
        {resolved.discrepancies.length > 0 && (
          <ul className="list-inside list-disc text-xs text-rose-300/90">
            {resolved.discrepancies.map((item) => (
              <li key={item.metric}>
                {item.metric}: computed {item.actual}, authoritative ledger {item.expected}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <section
      data-testid="analytics-authority-banner"
      data-authority-status="unavailable"
      role="status"
      aria-live="polite"
      className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-zinc-900/90 px-4 py-3 text-sm text-amber-200"
    >
      <div className="flex items-center gap-2.5">
        <AlertTriangle size={18} className="shrink-0 text-amber-400" />
        <span>
          Authoritative ledger state is unavailable — displaying unverified cached projections.
        </span>
      </div>
      <span data-testid="analytics-freshness-badge" className="text-xs text-amber-300">
        Authority unavailable ({resolved.reason ?? "missing_authority"})
      </span>
    </section>
  );
}

function MetricCard({
  title,
  value,
  detail,
  icon: Icon,
  accent,
  isAuthoritative,
}: {
  title: string;
  value: string;
  detail: string;
  icon: typeof Activity;
  accent: string;
  isAuthoritative: boolean;
}) {
  return (
    <article className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5 shadow-xl shadow-black/10">
      <div className="mb-6 flex items-start justify-between">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">{title}</p>
        <span className={`grid size-9 place-items-center rounded-xl bg-white/5 ${accent}`}>
          <Icon size={18} />
        </span>
      </div>
      <p className="text-3xl font-semibold tracking-tight text-white">{value}</p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-sm text-zinc-500">{detail}</p>
        {!isAuthoritative && (
          <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
            Unverified
          </span>
        )}
      </div>
    </article>
  );
}

const DASHBOARD_METRIC_KEYS: AnalyticsMetricKey[] = [
  "activeCampaigns",
  "totalTreesPlanted",
  "totalCo2SequesteredKg",
  "sponsorGrowthPercent",
  "campaignCompletionRate",
  "revenue",
];

export default function AnalyticsPage() {
  const { data, isLoading, isError, dataUpdatedAt, refetch, isFetching } = useQuery<DashboardData>({
    queryKey: ["admin-analytics-dashboard"],
    queryFn: async () => {
      const response = await fetch("/api/analytics/dashboard", { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load analytics");
      return (await response.json()).data;
    },
    refetchInterval: 15_000,
  });

  if (isLoading) return <main className="p-6 text-zinc-400">Loading analytics dashboard...</main>;
  if (isError || !data) return <main className="p-6 text-rose-300">Analytics are temporarily unavailable.</main>;

  const { metrics, authority } = data;
  const isAuthoritative = Boolean(authority?.isAuthoritative && authority?.state === "fresh");
  const definitions = data.metricDefinitions ?? ANALYTICS_METRIC_DEFINITIONS;
  const lastUpdated = new Date(dataUpdatedAt || data.updatedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const chartData = data.monthlyTrend.map((point) => ({
    ...point,
    label: new Date(`${point.month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short" }),
  }));

  return (
    <main className="min-h-full overflow-y-auto bg-[#101112] px-4 py-7 text-white md:px-8 lg:px-10">
      <header className="mb-6 flex flex-col justify-between gap-4 border-b border-zinc-800 pb-7 sm:flex-row sm:items-end">
        <div>
          <div className="mb-3 flex items-center gap-2 text-emerald-400">
            <Activity size={15} />
            <span className="text-xs font-bold uppercase tracking-[0.2em]">Live operations</span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Campaign analytics</h1>
          <p className="mt-2 max-w-xl text-sm text-zinc-400">
            A real-time view of campaign health, environmental impact, and platform momentum.
          </p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="inline-flex items-center gap-2 self-start rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:border-emerald-400 hover:text-white sm:self-auto"
          disabled={isFetching}
        >
          <RefreshCw size={15} className={isFetching ? "animate-spin" : ""} /> Refresh
        </button>
      </header>

      <AuthorityBanner authority={authority} />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          title="Active campaigns"
          value={formatNumber(metrics.activeCampaigns)}
          detail="Currently accepting support"
          icon={Sprout}
          accent="text-emerald-400"
          isAuthoritative={isAuthoritative}
        />
        <MetricCard
          title="Trees planted"
          value={formatNumber(metrics.totalTreesPlanted)}
          detail="Across all campaigns"
          icon={Leaf}
          accent="text-lime-400"
          isAuthoritative={isAuthoritative}
        />
        <MetricCard
          title="CO2 sequestered"
          value={`${formatNumber(metrics.totalCo2SequesteredKg / 1000)} t`}
          detail="Projected annual impact"
          icon={BarChart3}
          accent="text-sky-400"
          isAuthoritative={isAuthoritative}
        />
        <MetricCard
          title="Sponsor growth"
          value={`${metrics.sponsorGrowthPercent >= 0 ? "+" : ""}${metrics.sponsorGrowthPercent}%`}
          detail="Last 30 days vs prior 30"
          icon={Users}
          accent="text-amber-400"
          isAuthoritative={isAuthoritative}
        />
        <MetricCard
          title="Completion rate"
          value={`${metrics.campaignCompletionRate}%`}
          detail="Campaigns reaching their goal"
          icon={Target}
          accent="text-violet-400"
          isAuthoritative={isAuthoritative}
        />
        <MetricCard
          title="Revenue"
          value={formatRevenue(metrics.revenue)}
          detail="All-time raised · stroops converted"
          icon={CircleDollarSign}
          accent="text-rose-400"
          isAuthoritative={isAuthoritative}
        />
      </section>

      <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5 md:p-7">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Platform momentum</h2>
            <p className="mt-1 text-sm text-zinc-500">Campaigns and sponsors by month</p>
          </div>
          <span className="text-xs text-zinc-600">Updated {lastUpdated}</span>
        </div>
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} barGap={8}>
              <CartesianGrid stroke="#27272a" vertical={false} />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#71717a", fontSize: 12 }} />
              <YAxis axisLine={false} tickLine={false} tick={{ fill: "#71717a", fontSize: 12 }} allowDecimals={false} />
              <Tooltip
                contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 10, color: "#fff" }}
                cursor={{ fill: "#ffffff08" }}
              />
              <Bar dataKey="campaigns" name="Campaigns" fill="#34d399" radius={[4, 4, 0, 0]} />
              <Bar dataKey="sponsors" name="Sponsors" fill="#38bdf8" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section
        data-testid="analytics-metric-definitions"
        className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 md:p-7"
      >
        <div className="mb-4 flex items-center gap-2 text-zinc-300">
          <BookOpen size={16} className="text-emerald-400" />
          <h2 className="text-base font-semibold">Metric methodology & authoritative sources</h2>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {DASHBOARD_METRIC_KEYS.map((key) => {
            const def = definitions[key];
            if (!def) return null;
            return (
              <div
                key={key}
                data-testid={`metric-definition-${key}`}
                className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3.5 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-zinc-200">{def.label}</span>
                  <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                    {def.unit}
                  </span>
                </div>
                <p className="mt-1.5 font-mono text-[11px] text-emerald-300/90">{def.formula}</p>
                <p className="mt-1 text-zinc-400">Source: {def.dataSource}</p>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}