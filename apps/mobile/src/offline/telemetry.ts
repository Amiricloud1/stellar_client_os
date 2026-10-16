/**
 * Privacy-safe offline sync telemetry.
 *
 * Emits aggregate sync health signals — queue depth, flush latency, retries
 * and failure classes — without ever touching user content. Draft wishlist
 * state (campaign ids), wallet data, and raw error messages are explicitly
 * excluded: the sink only forwards an allowlist of numeric counters and
 * closed-enum strings, so an accidental extra field can never leak.
 *
 * Telemetry is opt-in: the sync engine only records events when a
 * {@link SyncTelemetry} instance is injected, so apps that do not wire a sink
 * keep the previous (silent) behavior.
 */

// ── Event payloads ───────────────────────────────────────────────────────────

/**
 * Coarse failure classification. Errors are reduced to these enums so that
 * telemetry never carries raw error messages (which may embed urls, ids or
 * user input).
 */
export type SyncFailureClass =
  | "network"
  | "timeout"
  | "auth"
  | "conflict"
  | "server"
  | "unknown";

export const SYNC_FAILURE_CLASSES: readonly SyncFailureClass[] = [
  "network",
  "timeout",
  "auth",
  "conflict",
  "server",
  "unknown",
];

/** Aggregate metrics for one queue flush attempt. */
export interface SyncFlushMetrics {
  /** Number of queued operations the flush attempted. */
  queueDepth: number;
  /** Operations that reached the server. */
  synced: number;
  /** Operations that failed and remain queued. */
  failed: number;
  /** Wall-clock duration of the flush, in milliseconds. */
  latencyMs: number;
  /** Operations that were retries (attempt count > 0 when the flush began). */
  retries: number;
}

/** Metrics for a single failed operation. */
export interface SyncFailureMetrics {
  failureClass: SyncFailureClass;
  /** 1 on the first attempt, 2+ on retries. */
  attempt: number;
}

/** Map of event name → payload shape. */
export interface SyncTelemetryEventMap {
  flush: SyncFlushMetrics;
  failure: SyncFailureMetrics;
}

export type SyncTelemetryEvent = keyof SyncTelemetryEventMap;

/** Minimal sink contract the sync engine records into. */
export interface SyncTelemetry {
  record<E extends SyncTelemetryEvent>(
    event: E,
    metrics: SyncTelemetryEventMap[E],
  ): void;
}

// ── Error classification ─────────────────────────────────────────────────────

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
}

/**
 * Reduce an arbitrary thrown value to a {@link SyncFailureClass}. The message
 * is deliberately ignored — only structural hints (name/code/status) are read,
 * so the resulting enum can be emitted without leaking user data.
 */
export function classifySyncError(error: unknown): SyncFailureClass {
  if (typeof error !== "object" || error === null) return "unknown";
  const e = error as ErrorLike;

  const status =
    typeof e.status === "number"
      ? e.status
      : typeof e.statusCode === "number"
        ? e.statusCode
        : undefined;
  if (status === 401 || status === 403) return "auth";
  if (status === 409) return "conflict";
  if (typeof status === "number" && status >= 400) return "server";

  if (e.name === "AbortError" || e.code === "ETIMEDOUT" || e.code === 28) {
    return "timeout";
  }
  if (
    e.name === "TypeError" ||
    e.name === "NetworkError" ||
    e.code === "ENOTFOUND" ||
    e.code === "ECONNREFUSED" ||
    e.code === "ECONNRESET" ||
    e.code === "EAI_AGAIN"
  ) {
    return "network";
  }
  return "unknown";
}

// ── Privacy-safe sink ────────────────────────────────────────────────────────

/** Coerce to a finite, non-negative counter; anything else becomes `0`. */
function toCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/** Keep only the closed-enum failure class; anything else becomes `unknown`. */
function toFailureClass(value: unknown): SyncFailureClass {
  return SYNC_FAILURE_CLASSES.includes(value as SyncFailureClass)
    ? (value as SyncFailureClass)
    : "unknown";
}

/**
 * Strip everything except the allowlisted fields for the event. Unknown keys
 * (campaign ids, wallet addresses, drafts, error messages, …) are dropped
 * before the payload reaches the transport.
 */
export function sanitizeSyncTelemetryEvent<E extends SyncTelemetryEvent>(
  event: E,
  metrics: SyncTelemetryEventMap[E],
): SyncTelemetryEventMap[E] {
  if (event === "flush") {
    const source = (metrics ?? {}) as Partial<SyncFlushMetrics>;
    return {
      queueDepth: toCounter(source.queueDepth),
      synced: toCounter(source.synced),
      failed: toCounter(source.failed),
      latencyMs: toCounter(source.latencyMs),
      retries: toCounter(source.retries),
    } as SyncTelemetryEventMap[E];
  }
  const source = (metrics ?? {}) as Partial<SyncFailureMetrics>;
  return {
    failureClass: toFailureClass(source.failureClass),
    attempt: toCounter(source.attempt) || 1,
  } as SyncTelemetryEventMap[E];
}

export interface PrivacySafeSyncTelemetryOptions {
  /**
   * Transport for a sanitized event. The object passed here only ever contains
   * the allowlisted fields of the corresponding payload type.
   */
  onEvent: <E extends SyncTelemetryEvent>(
    event: E,
    metrics: SyncTelemetryEventMap[E],
  ) => void;
  /**
   * Opt-out switch. When `false` (the default is `true`) no event — sanitized
   * or otherwise — reaches `onEvent`.
   */
  enabled?: boolean;
}

/**
 * Build a {@link SyncTelemetry} sink that forwards only sanitized payloads
 * when enabled, and drops everything when opted out.
 */
export function createPrivacySafeSyncTelemetry(
  options: PrivacySafeSyncTelemetryOptions,
): SyncTelemetry {
  const enabled = options.enabled ?? true;
  return {
    record<E extends SyncTelemetryEvent>(
      event: E,
      metrics: SyncTelemetryEventMap[E],
    ): void {
      if (!enabled) return;
      options.onEvent(event, sanitizeSyncTelemetryEvent(event, metrics));
    },
  };
}

