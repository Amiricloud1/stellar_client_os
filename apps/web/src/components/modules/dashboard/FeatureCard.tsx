import Link from "next/link";
import { AlertCircle, ArrowRight, CheckCircle2, Inbox, Loader2 } from "lucide-react";

export type FeatureCardState =
  | "default"
  | "loading"
  | "empty"
  | "error"
  | "disabled"
  | "success";

export interface FeatureCardProps {
  title: string;
  description: string;
  linkText: string;
  link: string;
  state?: FeatureCardState;
  errorMessage?: string;
  statusBadge?: string;
}

const FeatureCard = ({
  link,
  title,
  linkText,
  description,
  state = "default",
  errorMessage,
  statusBadge,
}: FeatureCardProps) => {
  if (state === "loading") {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={`Loading ${title || "card"}`}
        data-testid="feature-card-loading"
        className="grid grid-rows-[auto_1fr_auto] p-5 lg:py-6 bg-zinc-800/50 border border-zinc-700 rounded-lg backdrop-blur relative overflow-hidden min-h-[14rem]"
      >
        <div className="flex items-center justify-between mb-4">
          <div className="h-6 w-2/3 animate-pulse rounded bg-zinc-700" />
          <Loader2 className="w-4 h-4 animate-spin text-zinc-400" aria-hidden="true" />
        </div>
        <div className="space-y-2 mb-4">
          <div className="h-4 w-full animate-pulse rounded bg-zinc-700/80" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-zinc-700/80" />
        </div>
        <div className="h-5 w-1/3 animate-pulse rounded bg-zinc-700" />
      </div>
    );
  }

  if (state === "empty") {
    return (
      <div
        data-testid="feature-card-empty"
        className="grid grid-rows-[auto_1fr_auto] p-5 lg:py-6 bg-zinc-800/30 border border-dashed border-zinc-700 rounded-lg backdrop-blur relative overflow-hidden min-h-[14rem]"
      >
        <div className="flex items-center gap-2 mb-4 text-zinc-400">
          <Inbox className="w-5 h-5" aria-hidden="true" />
          <h2 className="text-xl font-semibold text-zinc-300">
            {title || "No items available"}
          </h2>
        </div>
        <p className="text-base tracking-wide leading-7 text-zinc-400 mb-4">
          {description || "There are no active items in this category yet."}
        </p>
        <span className="text-sm text-zinc-500">{linkText || "Check back soon"}</span>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div
        role="alert"
        data-testid="feature-card-error"
        className="grid grid-rows-[auto_1fr_auto] p-5 lg:py-6 bg-rose-950/30 border border-rose-500/40 rounded-lg backdrop-blur relative overflow-hidden min-h-[14rem]"
      >
        <div className="flex items-start justify-between gap-2 mb-4">
          <h2 className="text-xl font-semibold text-rose-200">{title}</h2>
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" aria-hidden="true" />
        </div>
        <p className="text-base tracking-wide leading-7 text-rose-200/90 mb-4">
          {errorMessage ?? description}
        </p>
        <Link className="flex items-center gap-x-2 hover:gap-x-3 transition-all text-rose-300" href={link}>
          <span className="font-semibold">{linkText}</span>
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </Link>
      </div>
    );
  }

  const isDisabled = state === "disabled";
  const isSuccess = state === "success";

  return (
    <div
      data-testid={`feature-card-${state}`}
      aria-disabled={isDisabled || undefined}
      className={`grid grid-rows-[auto_1fr_auto] p-5 lg:py-6 rounded-lg backdrop-blur relative overflow-hidden min-h-[14rem] border ${
        isSuccess
          ? "bg-emerald-950/20 border-emerald-500/40"
          : isDisabled
          ? "bg-zinc-900/40 border-zinc-800 opacity-60"
          : "bg-zinc-800/50 border-zinc-700"
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-4">
        <h2 className="text-xl font-semibold text-white">{title}</h2>
        {isSuccess && (
          <span
            role="status"
            className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-300"
          >
            <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
            {statusBadge ?? "Verified"}
          </span>
        )}
        {isDisabled && (
          <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-400">
            {statusBadge ?? "Unavailable"}
          </span>
        )}
      </div>
      <p className="text-base tracking-wide leading-7 text-gray-300 mb-4">{description}</p>
      {isDisabled ? (
        <span
          aria-disabled="true"
          className="flex items-center gap-x-2 text-zinc-500 cursor-not-allowed select-none"
        >
          <span className="font-semibold">{linkText}</span>
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </span>
      ) : (
        <Link className="flex items-center gap-x-2 hover:gap-x-3 transition-all" href={link}>
          <span className="text-zinc-100 font-semibold">{linkText}</span>
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </Link>
      )}
    </div>
  );
};

export default FeatureCard;
