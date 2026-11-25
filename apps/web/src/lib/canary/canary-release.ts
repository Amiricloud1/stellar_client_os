/**
 * Canary releases with rollback signals — issue #282
 *
 * A canary release moves a new build through an ordered set of traffic stages
 * (1% → 5% → 25% → 50% → 100%). Promotion is allowed only while every critical
 * journey is inside its SLO budget and every registered data-integrity check
 * passes. A critical signal automatically stops the rollout and invokes the
 * rollback handler; a blocking signal holds traffic where it is.
 *
 * The controller is the authoritative decision boundary for rollout state. It
 * is deliberately pure with respect to transport concerns: route handlers call
 * it, and it accepts injected metric/integrity providers so operators can wire
 * the platform's real signals without weakening the gate in tests.
 *
 * Rollback criteria are rehearsed before a release starts. `rehearseRollback`
 * records a rehearsal for an exact (release, previousRelease) pair, and `start`
 * refuses to begin unless a matching rehearsal passed. Changing the rollback
 * handler or the integrity-check set invalidates the rehearsal, so a green
 * rehearsal always describes the criteria that will actually be enforced.
 */

import type { CriticalFlow } from "../slo/slo.types";
import { SLO_DEFINITIONS } from "../slo/slo-definitions";
import { SLOTracker } from "../slo/slo-tracker";

/** Ordered rollout stages. The last stage promotes the release to stable. */
export type CanaryStageName = "internal" | "early" | "partial" | "majority" | "full";

export interface CanaryStage {
  readonly name: CanaryStageName;
  /** Percentage of production traffic served by the canary build. */
  readonly trafficPercent: number;
}

export const CANARY_STAGES: readonly CanaryStage[] = [
  { name: "internal", trafficPercent: 1 },
  { name: "early", trafficPercent: 5 },
  { name: "partial", trafficPercent: 25 },
  { name: "majority", trafficPercent: 50 },
  { name: "full", trafficPercent: 100 },
] as const;

export type CanaryState = "idle" | "canary" | "stable" | "rolled_back";

export type RollbackSignalCode =
  | "CRITICAL_JOURNEY_BURN_RATE"
  | "CRITICAL_JOURNEY_LATENCY"
  | "CRITICAL_JOURNEY_NO_SIGNAL"
  | "DATA_INTEGRITY_FAILED"
  | "DATA_INTEGRITY_NO_SIGNAL"
  | "MANUAL_ROLLBACK";

/**
 * `critical` signals stop the rollout immediately; `blocking` signals merely
 * prevent promotion until the condition clears.
 */
export type RollbackSignalSeverity = "blocking" | "critical";

export interface RollbackSignal {
  readonly code: RollbackSignalCode;
  readonly severity: RollbackSignalSeverity;
  readonly message: string;
  readonly flow?: CriticalFlow;
  readonly check?: string;
  readonly observed?: number;
  readonly threshold?: number;
}

export type JourneyEvaluationStatus =
  | "healthy"
  | "degraded"
  | "no_signal"
  | "rollback";

export interface JourneyEvaluation {
  readonly flow: CriticalFlow;
  readonly totalRequests: number;
  readonly burnRate: number;
  readonly p95Ms: number;
  readonly availabilityRate: number;
  readonly targetAvailability: number;
  readonly targetP95Ms: number;
  readonly status: JourneyEvaluationStatus;
}

export type IntegrityStatus = "passed" | "failed" | "error" | "stale";

export interface IntegrityCheckObservation {
  readonly status: "pass" | "fail";
  readonly message?: string;
  /** When the observation was produced. Stale observations block promotion. */
  readonly observedAt?: number;
}

export interface IntegrityCheck {
  readonly name: string;
  readonly description?: string;
  /** Data-integrity checks are critical unless explicitly marked otherwise. */
  readonly critical?: boolean;
  readonly run:
    | ((context: { now: number }) => IntegrityCheckObservation)
    | ((context: { now: number }) => Promise<IntegrityCheckObservation>);
}

export interface IntegrityCheckResult {
  readonly name: string;
  readonly critical: boolean;
  readonly status: IntegrityStatus;
  readonly message: string | null;
  readonly observedAt: number | null;
  readonly durationMs: number;
}

export interface RollbackContext {
  readonly release: string;
  readonly previousRelease: string;
  readonly reason: string;
  readonly actor: string;
  readonly dryRun: boolean;
  readonly signals: readonly RollbackSignal[];
}

export type RollbackHandler = (context: RollbackContext) => Promise<void>;

export interface RollbackRehearsalCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly message: string;
}

export interface RollbackRehearsal {
  readonly release: string;
  readonly previousRelease: string;
  readonly actor: string;
  readonly rehearsedAt: number;
  readonly passed: boolean;
  readonly checks: readonly RollbackRehearsalCheck[];
}

export type RollbackStatus = "not_required" | "in_progress" | "completed" | "failed";

export interface RollbackState {
  readonly status: RollbackStatus;
  readonly signals: readonly RollbackSignal[];
  readonly lastRollbackAt: number | null;
  readonly failure: string | null;
}

export interface CanaryEvaluation {
  readonly evaluatedAt: number;
  readonly windowMs: number;
  readonly healthy: boolean;
  readonly canPromote: boolean;
  readonly mustRollback: boolean;
  readonly journeys: readonly JourneyEvaluation[];
  readonly integrity: readonly IntegrityCheckResult[];
  readonly signals: readonly RollbackSignal[];
}

export type CanaryEventAction =
  | "rehearsed"
  | "started"
  | "advanced"
  | "blocked"
  | "evaluated"
  | "rolled_back"
  | "rollback_failed";

export interface CanaryEvent {
  readonly at: number;
  readonly actor: string;
  readonly action: CanaryEventAction;
  readonly stage: CanaryStageName | null;
  readonly trafficPercent: number;
  readonly message: string;
}

export interface CanaryStageStatus {
  readonly name: CanaryStageName;
  readonly trafficPercent: number;
  readonly index: number;
  readonly total: number;
}

export interface CanaryStatus {
  readonly state: CanaryState;
  readonly release: string | null;
  readonly previousRelease: string | null;
  readonly stage: CanaryStageStatus | null;
  readonly startedAt: number | null;
  readonly stageStartedAt: number | null;
  readonly lastEvaluation: CanaryEvaluation | null;
  readonly rehearsal: RollbackRehearsal | null;
  readonly rollback: RollbackState;
  readonly nextActions: readonly string[];
  readonly history: readonly CanaryEvent[];
}

export type CanaryErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_STATE"
  | "REHEARSAL_REQUIRED"
  | "OBSERVATION_WINDOW_NOT_MET"
  | "HEALTH_GATE_BLOCKED"
  | "ROLLBACK_TRIGGERED"
  | "ROLLBACK_NOT_READY";

export class CanaryReleaseError extends Error {
  constructor(
    readonly code: CanaryErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CanaryReleaseError";
  }
}

/** Minimal metric source required by the controller (SLOTracker satisfies it). */
export interface JourneyMetricsProvider {
  getMetrics: (
    flow: CriticalFlow,
    windowMs: number,
    now?: number,
  ) => {
    totalRequests: number;
    burnRate?: number;
    p95Ms: number;
    availabilityRate: number;
  };
  calculateBurnRate?: (flow: CriticalFlow, windowMs: number, now?: number) => number;
}

export interface CanaryReleaseOptions {
  readonly metrics?: JourneyMetricsProvider;
  readonly clock?: () => number;
  /** Signal window used for every critical journey. Default: 15 minutes. */
  readonly windowMs?: number;
  /** Minimum samples per journey before a stage may be promoted. */
  readonly minSamplesPerJourney?: number;
  /** Burn rate that holds promotion. Default: 2.0x (24h elevated alert). */
  readonly promotionBurnRate?: number;
  /** Burn rate that triggers rollback. Default: 14.4x (1h critical alert). */
  readonly rollbackBurnRate?: number;
  /** p95 latency above the SLO target holds promotion. */
  readonly promotionLatencyRatio?: number;
  /** p95 latency above this multiple of the SLO target triggers rollback. */
  readonly rollbackLatencyRatio?: number;
  /** Observation time required at a stage before promotion. Default: 10 min. */
  readonly minObservationMs?: number;
  /** Fail an integrity observation older than this. Default: 5 min. */
  readonly maxIntegritySignalAgeMs?: number;
  /** Upper bound for one integrity check. Default: 5 seconds. */
  readonly integrityTimeoutMs?: number;
  /** Require a matching rehearsal before starting. Default: true. */
  readonly requireRehearsal?: boolean;
  /** Automatically roll back when a critical signal is observed. Default: true. */
  readonly autoRollback?: boolean;
  readonly maxHistory?: number;
  readonly rollbackHandler?: RollbackHandler | null;
}

export interface StartReleaseInput {
  readonly release: string;
  readonly previousRelease: string;
  readonly actor: string;
}

export interface RehearseRollbackInput {
  readonly release: string;
  readonly previousRelease: string;
  readonly actor: string;
}

export interface RollbackInput {
  readonly actor: string;
  readonly reason: string;
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MIN_SAMPLES = 20;
const DEFAULT_PROMOTION_BURN_RATE = 2.0;
const DEFAULT_ROLLBACK_BURN_RATE = 14.4;
const DEFAULT_PROMOTION_LATENCY_RATIO = 1.0;
const DEFAULT_ROLLBACK_LATENCY_RATIO = 1.5;
const DEFAULT_MIN_OBSERVATION_MS = 10 * 60 * 1000;
const DEFAULT_MAX_INTEGRITY_SIGNAL_AGE_MS = 5 * 60 * 1000;
const DEFAULT_INTEGRITY_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_HISTORY = 100;

const CRITICAL_FLOWS: readonly CriticalFlow[] = [
  "reads",
  "submission",
  "webhooks",
  "sync",
];

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CanaryReleaseError(
      "INVALID_ARGUMENT",
      `${field} must be a non-empty string.`,
      { field },
    );
  }
  return value.trim();
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Authoritative canary rollout controller. One instance owns one active
 * release; create a new instance (or use the module singleton) per process.
 */
export class CanaryReleaseController {
  private readonly metrics: JourneyMetricsProvider;
  private readonly clock: () => number;
  private readonly windowMs: number;
  private readonly minSamplesPerJourney: number;
  private readonly promotionBurnRate: number;
  private readonly rollbackBurnRate: number;
  private readonly promotionLatencyRatio: number;
  private readonly rollbackLatencyRatio: number;
  private readonly minObservationMs: number;
  private readonly maxIntegritySignalAgeMs: number;
  private readonly integrityTimeoutMs: number;
  private readonly requireRehearsalSetting: boolean;
  private readonly autoRollbackSetting: boolean;
  private readonly maxHistory: number;

  private rollbackHandler: RollbackHandler | null;
  private integrityChecks: IntegrityCheck[] = [];
  private history: CanaryEvent[] = [];

  private state: CanaryState = "idle";
  private release: string | null = null;
  private previousRelease: string | null = null;
  private stageIndex = -1;
  private startedAt: number | null = null;
  private stageStartedAt: number | null = null;
  private lastEvaluation: CanaryEvaluation | null = null;
  private rehearsal: RollbackRehearsal | null = null;
  private rollbackStatus: RollbackStatus = "not_required";
  private rollbackFailure: string | null = null;
  private lastRollbackAt: number | null = null;

  constructor(options: CanaryReleaseOptions = {}) {
    this.metrics = options.metrics ?? SLOTracker.getInstance();
    this.clock = options.clock ?? (() => Date.now());
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.minSamplesPerJourney =
      options.minSamplesPerJourney ?? DEFAULT_MIN_SAMPLES;
    this.promotionBurnRate =
      options.promotionBurnRate ?? DEFAULT_PROMOTION_BURN_RATE;
    this.rollbackBurnRate =
      options.rollbackBurnRate ?? DEFAULT_ROLLBACK_BURN_RATE;
    this.promotionLatencyRatio =
      options.promotionLatencyRatio ?? DEFAULT_PROMOTION_LATENCY_RATIO;
    this.rollbackLatencyRatio =
      options.rollbackLatencyRatio ?? DEFAULT_ROLLBACK_LATENCY_RATIO;
    this.minObservationMs =
      options.minObservationMs ?? DEFAULT_MIN_OBSERVATION_MS;
    this.maxIntegritySignalAgeMs =
      options.maxIntegritySignalAgeMs ?? DEFAULT_MAX_INTEGRITY_SIGNAL_AGE_MS;
    this.integrityTimeoutMs =
      options.integrityTimeoutMs ?? DEFAULT_INTEGRITY_TIMEOUT_MS;
    this.requireRehearsalSetting = options.requireRehearsal ?? true;
    this.autoRollbackSetting = options.autoRollback ?? true;
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.rollbackHandler = options.rollbackHandler ?? null;
  }

  // ── Configuration ────────────────────────────────────────────────────────

  /**
   * Registers (or replaces) a data-integrity check. Because the rehearsal must
   * describe the criteria actually enforced, any check change invalidates a
   * previous rehearsal.
   */
  registerIntegrityCheck(check: IntegrityCheck): void {
    if (!check || typeof check.name !== "string" || check.name.trim() === "") {
      throw new CanaryReleaseError(
        "INVALID_ARGUMENT",
        "Integrity check name must be a non-empty string.",
        { field: "name" },
      );
    }
    if (typeof check.run !== "function") {
      throw new CanaryReleaseError(
        "INVALID_ARGUMENT",
        `Integrity check '${check.name}' must provide a run() function.`,
        { field: "run", check: check.name },
      );
    }
    this.integrityChecks = [
      ...this.integrityChecks.filter((entry) => entry.name !== check.name),
      { ...check, name: check.name.trim() },
    ];
    this.rehearsal = null;
  }

  clearIntegrityChecks(): void {
    this.integrityChecks = [];
    this.rehearsal = null;
  }

  listIntegrityChecks(): readonly Pick<IntegrityCheck, "name" | "description" | "critical">[] {
    return this.integrityChecks.map(({ name, description, critical }) => ({
      name,
      description,
      critical,
    }));
  }

  setRollbackHandler(handler: RollbackHandler | null): void {
    this.rollbackHandler = handler;
    this.rehearsal = null;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Rehearses rollback criteria for an exact release pair. The rehearsal is a
   * dry run: it validates the rollback target, the handler, and the presence
   * of both journey and data-integrity signals, then invokes the handler with
   * `dryRun: true`. It never changes rollout state.
   */
  async rehearseRollback(input: RehearseRollbackInput): Promise<RollbackRehearsal> {
    const release = requireNonEmpty(input.release, "release");
    const previousRelease = requireNonEmpty(input.previousRelease, "previousRelease");
    const actor = requireNonEmpty(input.actor, "actor");
    const at = this.clock();

    const checks: RollbackRehearsalCheck[] = [];
    const addCheck = (name: string, passed: boolean, message: string) => {
      checks.push({ name, passed, message });
    };

    addCheck(
      "rollback-target",
      release !== previousRelease,
      release === previousRelease
        ? "release and previousRelease must differ; there is nothing to roll back to."
        : `Rollback target '${previousRelease}' recorded for '${release}'.`,
    );

    addCheck(
      "rollback-handler",
      this.rollbackHandler !== null,
      this.rollbackHandler === null
        ? "No rollback handler is configured; traffic would stop but the previous build would not be restored."
        : "Rollback handler is configured.",
    );

    addCheck(
      "journey-signals",
      CRITICAL_FLOWS.every((flow) => Boolean(SLO_DEFINITIONS[flow])),
      "Reads, submission, webhooks, and sync SLO targets are registered.",
    );

    addCheck(
      "data-integrity-signals",
      this.integrityChecks.length > 0,
      this.integrityChecks.length > 0
        ? `${this.integrityChecks.length} data-integrity check(s) registered.`
        : "No data-integrity checks are registered; promotion would always be blocked.",
    );

    let handlerError: string | null = null;
    if (this.rollbackHandler) {
      try {
        await withTimeout(
          () =>
            this.rollbackHandler!({
              release,
              previousRelease,
              reason: "rollback rehearsal (dry run)",
              actor,
              dryRun: true,
              signals: [],
            }),
          this.integrityTimeoutMs,
          "Rollback rehearsal",
        );
      } catch (error) {
        handlerError =
          error instanceof Error ? error.message : String(error);
      }
    }
    addCheck(
      "handler-dry-run",
      handlerError === null,
      handlerError === null
        ? "Rollback handler dry run completed."
        : `Rollback handler dry run failed: ${handlerError}`,
    );

    const passed = checks.every((check) => check.passed);
    const rehearsal: RollbackRehearsal = {
      release,
      previousRelease,
      actor,
      rehearsedAt: at,
      passed,
      checks,
    };
    this.rehearsal = rehearsal;
    this.record("rehearsed", actor, passed ? "Rollback rehearsal passed." : "Rollback rehearsal failed.");
    return rehearsal;
  }

  /**
   * Starts a canary release at the first traffic stage.
   *
   * @throws CanaryReleaseError `REHEARSAL_REQUIRED` when no matching rehearsal
   *         passed, `INVALID_STATE` when a canary is already active.
   */
  start(input: StartReleaseInput): CanaryStatus {
    const release = requireNonEmpty(input.release, "release");
    const previousRelease = requireNonEmpty(input.previousRelease, "previousRelease");
    const actor = requireNonEmpty(input.actor, "actor");

    if (this.state === "canary") {
      throw new CanaryReleaseError(
        "INVALID_STATE",
        `Canary release '${this.release}' is already active at stage '${this.currentStage().name}'.`,
        { state: this.state, release: this.release },
      );
    }

    this.assertRehearsed(release, previousRelease);

    this.state = "canary";
    this.release = release;
    this.previousRelease = previousRelease;
    this.stageIndex = 0;
    this.startedAt = this.clock();
    this.stageStartedAt = this.startedAt;
    this.rollbackStatus = "not_required";
    this.rollbackFailure = null;
    this.lastRollbackAt = null;
    this.lastEvaluation = null;
    this.record("started", actor, `Started canary '${release}' at 1% traffic.`);
    return this.getStatus();
  }

  /**
   * Evaluates every critical journey and data-integrity check.
   *
   * When the release is canary and a critical signal is present, the rollout is
   * stopped and the rollback handler is invoked (`autoRollback` defaults on).
   */
  async evaluate(): Promise<CanaryEvaluation> {
    const at = this.clock();
    const journeys: JourneyEvaluation[] = [];
    const signals: RollbackSignal[] = [];

    for (const flow of CRITICAL_FLOWS) {
      const definition = SLO_DEFINITIONS[flow];
      const metrics = this.metrics.getMetrics(flow, this.windowMs, at);
      const burnRate =
        typeof metrics.burnRate === "number"
          ? metrics.burnRate
          : this.metrics.calculateBurnRate
            ? this.metrics.calculateBurnRate(flow, this.windowMs, at)
            : 0;

      let status: JourneyEvaluationStatus = "healthy";

      if (metrics.totalRequests < this.minSamplesPerJourney) {
        status = "no_signal";
        signals.push({
          code: "CRITICAL_JOURNEY_NO_SIGNAL",
          severity: "blocking",
          flow,
          observed: metrics.totalRequests,
          threshold: this.minSamplesPerJourney,
          message: `${flow} has ${metrics.totalRequests} sample(s) in the ${Math.round(
            this.windowMs / 1000,
          )}s window; at least ${this.minSamplesPerJourney} are required before promotion.`,
        });
      }

      if (burnRate >= this.rollbackBurnRate) {
        status = "rollback";
        signals.push({
          code: "CRITICAL_JOURNEY_BURN_RATE",
          severity: "critical",
          flow,
          observed: burnRate,
          threshold: this.rollbackBurnRate,
          message: `${flow} burn rate ${burnRate}x exceeds the rollback threshold of ${this.rollbackBurnRate}x.`,
        });
      } else if (burnRate >= this.promotionBurnRate) {
        status = status === "healthy" ? "degraded" : status;
        signals.push({
          code: "CRITICAL_JOURNEY_BURN_RATE",
          severity: "blocking",
          flow,
          observed: burnRate,
          threshold: this.promotionBurnRate,
          message: `${flow} burn rate ${burnRate}x is above the promotion threshold of ${this.promotionBurnRate}x.`,
        });
      }

      const rollbackLatencyMs = definition.target.latencyP95Ms * this.rollbackLatencyRatio;
      const promotionLatencyMs = definition.target.latencyP95Ms * this.promotionLatencyRatio;

      if (metrics.p95Ms > rollbackLatencyMs) {
        status = "rollback";
        signals.push({
          code: "CRITICAL_JOURNEY_LATENCY",
          severity: "critical",
          flow,
          observed: metrics.p95Ms,
          threshold: rollbackLatencyMs,
          message: `${flow} p95 latency ${metrics.p95Ms}ms exceeds the rollback threshold of ${rollbackLatencyMs}ms.`,
        });
      } else if (metrics.p95Ms > promotionLatencyMs) {
        status = status === "healthy" ? "degraded" : status;
        signals.push({
          code: "CRITICAL_JOURNEY_LATENCY",
          severity: "blocking",
          flow,
          observed: metrics.p95Ms,
          threshold: promotionLatencyMs,
          message: `${flow} p95 latency ${metrics.p95Ms}ms is above the SLO target of ${promotionLatencyMs}ms.`,
        });
      }

      journeys.push({
        flow,
        totalRequests: metrics.totalRequests,
        burnRate,
        p95Ms: metrics.p95Ms,
        availabilityRate: metrics.availabilityRate,
        targetAvailability: definition.target.availability,
        targetP95Ms: definition.target.latencyP95Ms,
        status,
      });
    }

    const integrity = await this.runIntegrityChecks(at);
    if (integrity.length === 0) {
      signals.push({
        code: "DATA_INTEGRITY_NO_SIGNAL",
        severity: "blocking",
        message:
          "No data-integrity checks are registered; promotion is blocked until at least one check is wired.",
      });
    }
    for (const result of integrity) {
      if (result.status === "passed") continue;
      const severity: RollbackSignalSeverity =
        result.critical || result.status === "failed" || result.status === "error"
          ? result.critical === false
            ? "blocking"
            : "critical"
          : "blocking";
      signals.push({
        code: "DATA_INTEGRITY_FAILED",
        severity,
        check: result.name,
        observed: result.observedAt ?? undefined,
        message:
          result.message ??
          (result.status === "stale"
            ? `Integrity check '${result.name}' is stale.`
            : `Integrity check '${result.name}' failed.`),
      });
    }

    const mustRollback = signals.some((signal) => signal.severity === "critical");
    const canPromote = signals.length === 0;
    const evaluation: CanaryEvaluation = {
      evaluatedAt: at,
      windowMs: this.windowMs,
      healthy: signals.length === 0,
      canPromote,
      mustRollback,
      journeys,
      integrity,
      signals,
    };
    this.lastEvaluation = evaluation;

    if (
      this.state === "canary" &&
      mustRollback &&
      this.autoRollbackSetting
    ) {
      await this.stopForRollback(
        evaluation,
        "automated canary rollback",
        "automated",
      );
    } else {
      this.record(
        "evaluated",
        "system",
        canPromote
          ? "All canary signals are healthy."
          : `${signals.length} canary signal(s) present; promotion ${canPromote ? "allowed" : "blocked"}.`,
      );
    }

    return evaluation;
  }

  /**
   * Promotes the release to the next traffic stage after a fresh evaluation.
   *
   * @throws CanaryReleaseError when the release is not canary, the observation
   *         window has not elapsed, the gate is blocked, or a critical signal
   *         triggered an automated rollback.
   */
  async advance(actorInput: string): Promise<CanaryStatus> {
    const actor = requireNonEmpty(actorInput, "actor");
    if (this.state !== "canary") {
      throw new CanaryReleaseError(
        "INVALID_STATE",
        "Only an active canary release can be promoted.",
        { state: this.state },
      );
    }
    this.assertRehearsed(this.release!, this.previousRelease!);

    const now = this.clock();
    const elapsed = now - (this.stageStartedAt ?? now);
    if (elapsed < this.minObservationMs) {
      const retryAfterMs = this.minObservationMs - elapsed;
      throw new CanaryReleaseError(
        "OBSERVATION_WINDOW_NOT_MET",
        `Stage '${this.currentStage().name}' has been observed for ${elapsed}ms; ${this.minObservationMs}ms is required.`,
        { retryAfterMs, minObservationMs: this.minObservationMs },
      );
    }

    const evaluation = await this.evaluate();
    if (evaluation.mustRollback) {
      throw new CanaryReleaseError(
        "ROLLBACK_TRIGGERED",
        this.rollbackStatus === "failed"
          ? "Critical canary signals triggered a rollback, but the rollback handler failed. Manual recovery is required."
          : "Critical canary signals triggered an automated rollback.",
        {
          signals: evaluation.signals,
          rollback: this.getStatus().rollback,
        },
      );
    }
    if (!evaluation.canPromote) {
      this.record("blocked", actor, "Promotion blocked by canary signals.");
      throw new CanaryReleaseError(
        "HEALTH_GATE_BLOCKED",
        "Canary signals are not healthy enough to promote this stage.",
        { signals: evaluation.signals },
      );
    }

    if (this.stageIndex >= CANARY_STAGES.length - 1) {
      this.state = "stable";
      this.record("advanced", actor, `Promoted '${this.release}' to stable at 100% traffic.`);
      return this.getStatus();
    }

    this.stageIndex += 1;
    this.stageStartedAt = now;
    const stage = this.currentStage();
    this.record(
      "advanced",
      actor,
      `Promoted '${this.release}' to '${stage.name}' at ${stage.trafficPercent}% traffic.`,
    );
    return this.getStatus();
  }

  /**
   * Stops traffic and restores the previous release. Manual rollback is always
   * available (even when signals look healthy) so operators are never trapped.
   *
   * Rollback duration is bounded by `integrityTimeoutMs`. A handler failure is
   * reported explicitly as `rollback.status === "failed"`; traffic remains
   * stopped either way.
   */
  async rollback(input: RollbackInput): Promise<CanaryStatus> {
    const actor = requireNonEmpty(input.actor, "actor");
    const reason = requireNonEmpty(input.reason, "reason");
    if (this.state !== "canary" && this.state !== "stable") {
      throw new CanaryReleaseError(
        "INVALID_STATE",
        "There is no active release to roll back.",
        { state: this.state },
      );
    }

    const base = this.lastEvaluation ?? this.emptyEvaluation();
    const signals: RollbackSignal[] = [
      ...base.signals.filter((signal) => signal.code !== "MANUAL_ROLLBACK"),
      {
        code: "MANUAL_ROLLBACK",
        severity: "critical",
        message: `Manual rollback requested: ${reason}`,
      },
    ];
    await this.stopForRollback(
      { ...base, signals, healthy: false, canPromote: false, mustRollback: true },
      reason,
      actor,
    );
    return this.getStatus();
  }

  getStatus(): CanaryStatus {
    const stage =
      this.stageIndex >= 0 &&
      (this.state === "canary" || this.state === "stable" || this.state === "rolled_back")
        ? this.currentStage()
        : null;
    const stageStatus: CanaryStageStatus | null = stage
      ? {
          name: stage.name,
          trafficPercent:
            this.state === "rolled_back" ? 0 : stage.trafficPercent,
          index: this.stageIndex,
          total: CANARY_STAGES.length,
        }
      : null;

    return {
      state: this.state,
      release: this.release,
      previousRelease: this.previousRelease,
      stage: stageStatus,
      startedAt: this.startedAt,
      stageStartedAt: this.stageStartedAt,
      lastEvaluation: this.lastEvaluation,
      rehearsal: this.rehearsal,
      rollback: {
        status: this.rollbackStatus,
        signals: this.lastEvaluation?.signals ?? [],
        lastRollbackAt: this.lastRollbackAt,
        failure: this.rollbackFailure,
      },
      nextActions: this.deriveNextActions(),
      history: [...this.history],
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private currentStage(): CanaryStage {
    const index = Math.max(0, Math.min(this.stageIndex, CANARY_STAGES.length - 1));
    return CANARY_STAGES[index];
  }

  private assertRehearsed(release: string, previousRelease: string): void {
    if (!this.requireRehearsalSetting) return;
    if (
      !this.rehearsal ||
      !this.rehearsal.passed ||
      this.rehearsal.release !== release ||
      this.rehearsal.previousRelease !== previousRelease
    ) {
      throw new CanaryReleaseError(
        "REHEARSAL_REQUIRED",
        `Rollback criteria for '${release}' → '${previousRelease}' have not been rehearsed successfully.`,
        { release, previousRelease },
      );
    }
  }

  private async runIntegrityChecks(now: number): Promise<IntegrityCheckResult[]> {
    const results: IntegrityCheckResult[] = [];
    for (const check of this.integrityChecks) {
      const startedAt = this.clock();
      try {
        const observation = await withTimeout(
          () => Promise.resolve(check.run({ now })),
          this.integrityTimeoutMs,
          `Integrity check '${check.name}'`,
        );
        const durationMs = this.clock() - startedAt;
        const observedAt = observation.observedAt ?? now;
        const stale = now - observedAt > this.maxIntegritySignalAgeMs;
        const passed = observation.status === "pass" && !stale;
        results.push({
          name: check.name,
          critical: check.critical ?? true,
          status: passed ? "passed" : stale ? "stale" : observation.status === "pass" ? "passed" : "failed",
          message: passed
            ? null
            : stale
              ? `Integrity check '${check.name}' observation is older than ${this.maxIntegritySignalAgeMs}ms.`
              : (observation.message ?? `Integrity check '${check.name}' failed.`),
          observedAt,
          durationMs,
        });
      } catch (error) {
        results.push({
          name: check.name,
          critical: check.critical ?? true,
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : `Integrity check '${check.name}' failed.`,
          observedAt: now,
          durationMs: this.clock() - startedAt,
        });
      }
    }
    return results;
  }

  private async stopForRollback(
    evaluation: CanaryEvaluation,
    reason: string,
    actor: string,
  ): Promise<void> {
    this.state = "rolled_back";
    this.rollbackStatus = "in_progress";
    this.rollbackFailure = null;
    this.lastRollbackAt = this.clock();
    this.lastEvaluation = evaluation;

    if (!this.rollbackHandler) {
      this.rollbackStatus = "failed";
      this.rollbackFailure =
        "No rollback handler is configured; traffic is stopped but the previous release was not restored.";
      this.record("rollback_failed", actor, this.rollbackFailure);
      return;
    }

    try {
      await withTimeout(
        () =>
          this.rollbackHandler!({
            release: this.release ?? "unknown",
            previousRelease: this.previousRelease ?? "unknown",
            reason,
            actor,
            dryRun: false,
            signals: evaluation.signals,
          }),
        this.integrityTimeoutMs,
        "Rollback handler",
      );
      this.rollbackStatus = "completed";
      this.record(
        "rolled_back",
        actor,
        `Rolled back '${this.release}' to '${this.previousRelease}': ${reason}.`,
      );
    } catch (error) {
      this.rollbackStatus = "failed";
      this.rollbackFailure =
        error instanceof Error ? error.message : String(error);
      this.record(
        "rollback_failed",
        actor,
        `Traffic stopped, but restoring '${this.previousRelease}' failed: ${this.rollbackFailure}`,
      );
    }
  }

  private emptyEvaluation(): CanaryEvaluation {
    return {
      evaluatedAt: this.clock(),
      windowMs: this.windowMs,
      healthy: false,
      canPromote: false,
      mustRollback: true,
      journeys: [],
      integrity: [],
      signals: [],
    };
  }

  private deriveNextActions(): string[] {
    switch (this.state) {
      case "idle":
        return [
          "Register at least one data-integrity check and configure a rollback handler.",
          "Rehearse rollback criteria with the planned release pair.",
          "Start the canary once the rehearsal passes.",
        ];
      case "canary":
        if (this.rollbackStatus === "failed") {
          return [
            "Traffic is stopped. Restore the previous release manually and verify data integrity.",
            "Record the rollback failure, fix the handler, and rehearse again before the next release.",
          ];
        }
        if (this.lastEvaluation?.mustRollback) {
          return [
            "Critical signals triggered a rollback; confirm the previous release is serving traffic.",
            "Triage the flagged journeys and integrity checks before starting a new canary.",
          ];
        }
        if (this.lastEvaluation && !this.lastEvaluation.canPromote) {
          return [
            "Hold traffic at this stage and resolve the blocking signals.",
            "Re-evaluate after the observation window before promoting.",
          ];
        }
        return [
          `Observe stage '${this.currentStage().name}' for at least ${Math.round(this.minObservationMs / 60000)} minute(s).`,
          "Advance only when a fresh evaluation reports no signals.",
        ];
      case "stable":
        return [
          "Monitor critical journeys and data integrity through the post-release window.",
          "Roll back to the previous release if a critical signal appears.",
        ];
      case "rolled_back":
        return [
          "Confirm the previous release is healthy and data integrity checks pass.",
          "Fix the release, rehearse rollback criteria again, and start a new canary.",
        ];
      default:
        return [];
    }
  }

  private record(action: CanaryEventAction, actor: string, message: string): void {
    const stage = this.stageIndex >= 0 ? this.currentStage() : null;
    this.history.push({
      at: this.clock(),
      actor,
      action,
      stage: stage?.name ?? null,
      trafficPercent: this.state === "rolled_back" ? 0 : (stage?.trafficPercent ?? 0),
      message,
    });
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(this.history.length - this.maxHistory);
    }
  }
}
