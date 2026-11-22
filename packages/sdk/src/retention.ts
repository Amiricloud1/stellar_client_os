/**
 * Data retention and auditable deletion for personal records — issue #106
 *
 * Inventories personal-data categories (tax records, verification records,
 * upload metadata), applies retention periods per category, and performs
 * auditable deletion. Every deletion is recorded (actor, action, target,
 * timestamp, request ID) without logging secrets, reusing the audit log from
 * issue #109.
 *
 * Compatibility / migration implications:
 * - Introducing retention makes existing personal records older than a
 *   category's retention period eligible for deletion. Operators should run a
 *   one-time `evaluateRetention` backfill against existing records before
 *   enabling automated deletion, and treat deletion as irreversible.
 * - Retention periods are configurable per deployment; changing them does not
 *   alter already-stored records, only future eligibility.
 *
 * All timestamps are ISO 8601 UTC. Records never store secrets.
 */

import { AuditLogger } from "./audit.js";

export type PersonalDataCategory = "tax" | "verification" | "upload_metadata";

// ---------------------------------------------------------------------------
// Replay projections across event-schema versions — issue #220
// ---------------------------------------------------------------------------

/**
 * A retained raw event, as originally ingested. Raw events are immutable and
 * are the authoritative source for replay. `schemaVersion` identifies the
 * event-schema version the payload was written with.
 */
export interface RawEvent {
  id: string;
  /** Monotonic sequence number; replay is ordered by this value. */
  sequence: number;
  /** Event-schema version the payload was written with. */
  schemaVersion: number;
  /** Event type, e.g. "record.created". */
  type: string;
  /** Opaque raw payload. Never contains secrets. */
  payload: Readonly<Record<string, unknown>>;
  /** ISO 8601 UTC ingestion timestamp. */
  recordedAt: string;
}

/** A projection of state derived from raw events. */
export interface Projection {
  /** Projection key (e.g. record id). */
  key: string;
  /** Projected value; JSON-serialisable. */
  value: Readonly<Record<string, unknown>>;
}

/**
 * Canonical mapping for a single event-schema version. Implementations must be
 * pure: the same raw event and target version must always yield the same
 * projection mutations.
 */
export interface SchemaMapping {
  /** Source schema version this mapping handles. */
  fromVersion: number;
  /** Target schema version this mapping produces. */
  toVersion: number;
  /** Applies the event to the projection map, returning a new map. */
  apply(
    projections: ReadonlyMap<string, Projection>,
    event: RawEvent
  ): Map<string, Projection>;
}

/** Explicit replay lifecycle states, surfaced to operators. */
export type ReplayStatus =
  | "pending"
  | "running"
  | "failed"
  | "mismatched"
  | "matched";

/** A single projection difference between replay and current output. */
export interface ProjectionDiff {
  key: string;
  /** "missing" = present in replay only; "extra" = current only. */
  kind: "changed" | "missing" | "extra";
  replayed?: Readonly<Record<string, unknown>>;
  current?: Readonly<Record<string, unknown>>;
}

/** Result of a replay run. */
export interface ReplayResult {
  status: ReplayStatus;
  targetVersion: number;
  /** Number of raw events applied. */
  eventsApplied: number;
  /** Deterministic digest of the replayed projections. */
  digest: string;
  diffs: ProjectionDiff[];
  /** Populated when status is "failed". */
  error?: string;
  /** Number of attempts made (retries increment this). */
  attempts: number;
}

/** Error raised by the replay subsystem. */
export class ReplayError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ReplayError";
    this.code = code;
    Object.setPrototypeOf(this, ReplayError.prototype);
  }
}

/** Stable, order-independent digest of a projection map. */
export function digestProjections(
  projections: ReadonlyMap<string, Projection>
): string {
  const keys = [...projections.keys()].sort();
  const canonical = keys.map((k) => {
    const value = projections.get(k)!.value;
    return [k, canonicalise(value)];
  });
  return JSON.stringify(canonical);
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalise(obj[key]);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic replay engine. Reads retained raw events, applies the canonical
 * mapping chain for a target schema version, and produces projections that can
 * be diffed against current outputs before cutover.
 *
 * Failure and recovery are explicit: a replay that throws mid-way leaves the
 * engine in status "failed" with the partial attempt recorded, and `replay()`
 * may be retried; each retry starts from a clean projection map so partial
 * state never leaks into a subsequent attempt.
 */
export class ReplayEngine {
  private mappings: Map<number, SchemaMapping>;
  private status: ReplayStatus = "pending";
  private lastResult?: ReplayResult;
  private attempts = 0;

  constructor(mappings: SchemaMapping[] = []) {
    this.mappings = new Map();
    for (const mapping of mappings) {
      this.mappings.set(mapping.fromVersion, mapping);
    }
  }

  /** Register or replace the mapping for a source schema version. */
  registerMapping(mapping: SchemaMapping): void {
    this.mappings.set(mapping.fromVersion, mapping);
  }

  /** Current replay status, surfaced to operators. */
  getStatus(): ReplayStatus {
    return this.status;
  }

  /** Result of the most recent replay attempt, if any. */
  getLastResult(): ReplayResult | undefined {
    return this.lastResult ? { ...this.lastResult } : undefined;
  }

  /**
   * Replays `events` into projections for `targetVersion`. Events are applied
   * in ascending `sequence` order. Throws ReplayError when no mapping chain
   * exists for an event's schema version.
   */
  replay(
    events: readonly RawEvent[],
    targetVersion: number
  ): ReplayResult {
    this.attempts += 1;
    this.status = "running";
    try {
      const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
      let projections = new Map<string, Projection>();
      let applied = 0;
      for (const event of ordered) {
        projections = this.applyEvent(projections, event, targetVersion);
        applied += 1;
      }
      const result: ReplayResult = {
        status: "matched",
        targetVersion,
        eventsApplied: applied,
        digest: digestProjections(projections),
        diffs: [],
        attempts: this.attempts,
      };
      this.lastResult = result;
      this.status = "matched";
      return { ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: ReplayResult = {
        status: "failed",
        targetVersion,
        eventsApplied: 0,
        digest: "",
        diffs: [],
        error: message,
        attempts: this.attempts,
      };
      this.lastResult = result;
      this.status = "failed";
      throw err;
    }
  }

  private applyEvent(
    projections: Map<string, Projection>,
    event: RawEvent,
    targetVersion: number
  ): Map<string, Projection> {
    let current = projections;
    let version = event.schemaVersion;
    const visited = new Set<number>();
    while (version !== targetVersion) {
      if (visited.has(version)) {
        throw new ReplayError(
          `Mapping cycle detected at schema version ${version}`,
          "MAPPING_CYCLE"
        );
      }
      visited.add(version);
      const mapping = this.mappings.get(version);
      if (!mapping) {
        throw new ReplayError(
          `No schema mapping from version ${version} ` +
            `(event "${event.id}", target ${targetVersion})`,
          "NO_MAPPING"
        );
      }
      current = mapping.apply(current, event);
      version = mapping.toVersion;
    }
    return current;
  }

  /**
   * Diffs replayed projections against current outputs. Sets status to
   * "matched" when identical, "mismatched" otherwise.
   */
  diff(
    replayed: ReadonlyMap<string, Projection>,
    current: ReadonlyMap<string, Projection>
  ): ProjectionDiff[] {
    const diffs: ProjectionDiff[] = [];
    const keys = new Set<string>([...replayed.keys(), ...current.keys()]);
    for (const key of [...keys].sort()) {
      const r = replayed.get(key);
      const c = current.get(key);
      if (r && !c) {
        diffs.push({ key, kind: "missing", replayed: r.value });
      } else if (!r && c) {
        diffs.push({ key, kind: "extra", current: c.value });
      } else if (r && c) {
        if (canonicalise(r.value) !== canonicalise(c.value)) {
          diffs.push({
            key,
            kind: "changed",
            replayed: r.value,
            current: c.value,
          });
        }
      }
    }
    this.status = diffs.length === 0 ? "matched" : "mismatched";
    if (this.lastResult) {
      this.lastResult = { ...this.lastResult, status: this.status, diffs };
    }
    return diffs;
  }
}

/** Authorisation context for cutover. */
export interface CutoverAuthorization {
  actor: string;
  actorRole: string;
  requestId: string;
}

/** Roles permitted to authorise a cutover. */
const CUTOVER_ROLES = new Set(["admin", "operator"]);

/**
 * Guards cutover behind a successful, matching replay. Cutover is blocked when
 * the replay failed, mismatched, or was never run, and when the actor is not
 * authorised. Every decision is audited.
 */
export class CutoverGuard {
  private engine: ReplayEngine;
  private logger: AuditLogger;

  constructor(engine: ReplayEngine, logger: AuditLogger = new AuditLogger()) {
    this.engine = engine;
    this.logger = logger;
  }

  /**
   * Returns true when cutover may proceed. Throws ReplayError when blocked so
   * the failure state is explicit to the caller.
   */
  assertCutoverAllowed(auth: CutoverAuthorization): void {
    if (!CUTOVER_ROLES.has(auth.actorRole)) {
      this.logger.record({
        actor: auth.actor,
        actorRole: auth.actorRole,
        action: "replay.cutover.denied",
        target: "replay:cutover",
        requestId: auth.requestId,
        reason: "unauthorized",
      });
      throw new ReplayError(
        `Actor "${auth.actor}" (${auth.actorRole}) is not authorised to ` +
          `authorise cutover`,
        "UNAUTHORIZED"
      );
    }

    const status = this.engine.getStatus();
    if (status !== "matched") {
      this.logger.record({
        actor: auth.actor,
        actorRole: auth.actorRole,
        action: "replay.cutover.blocked",
        target: "replay:cutover",
        requestId: auth.requestId,
        reason: status,
      });
      throw new ReplayError(
        `Cutover blocked: replay status is "${status}"`,
        "CUTOVER_BLOCKED"
      );
    }

    this.logger.record({
      actor: auth.actor,
      actorRole: auth.actorRole,
      action: "replay.cutover.allowed",
      target: "replay:cutover",
      requestId: auth.requestId,
    });
  }
}

export interface RetentionRule {
  category: PersonalDataCategory;
  /** Retention period in days. */
  retentionDays: number;
  description: string;
}

export interface PersonalRecord {
  id: string;
  category: PersonalDataCategory;
  /** Public subject identifier (e.g. wallet address). Never a secret. */
  subjectId: string;
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
}

export interface DeletionRequest {
  recordId: string;
  reason: string;
  actor: string;
  requestId: string;
  /** Bypass the retention check (emergency/legal hold override). Audited. */
  emergencyOverride?: boolean;
}

export interface DeletionRecord {
  id: string;
  recordId: string;
  category: PersonalDataCategory;
  subjectId: string;
  action: "DELETE";
  reason: string;
  actor: string;
  requestId: string;
  timestamp: string; // ISO 8601 UTC
  emergencyOverride: boolean;
}

/** Default retention periods per personal-data category. */
export const DEFAULT_RETENTION_RULES: RetentionRule[] = [
  {
    category: "tax",
    retentionDays: 2555, // 7 years
    description:
      "Tax and earnings records retained to satisfy statutory filing windows.",
  },
  {
    category: "verification",
    retentionDays: 1095, // 3 years
    description:
      "Identity-verification records retained for the verification lifecycle.",
  },
  {
    category: "upload_metadata",
    retentionDays: 90,
    description:
      "File-upload metadata retained only for operational troubleshooting.",
  },
];

/** Error raised by the retention subsystem. */
export class RetentionError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "RetentionError";
    this.code = code;
    Object.setPrototypeOf(this, RetentionError.prototype);
  }
}

/** Clock provider. Override for deterministic tests. */
export interface RetentionClock {
  now(): string;
}

class SystemClock implements RetentionClock {
  now(): string {
    return new Date().toISOString();
  }
}

/** Generates ids. Override for deterministic tests. */
export interface RetentionIdGenerator {
  next(): string;
}

class DefaultIdGenerator implements RetentionIdGenerator {
  private counter = 0;
  next(): string {
    return `retention-${Date.now()}-${++this.counter}`;
  }
}

function parseMs(iso: string): number {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) {
    throw new RetentionError(`Invalid timestamp: ${iso}`, "INVALID_TIMESTAMP");
  }
  return ms;
}

/**
 * Resolves the retention rule for a category and evaluates whether records are
 * past their retention period. Pure and deterministic given `now`.
 */
export class RetentionPolicy {
  private rules: Map<PersonalDataCategory, RetentionRule>;

  constructor(rules: RetentionRule[] = DEFAULT_RETENTION_RULES) {
    this.rules = new Map();
    for (const rule of rules) {
      this.rules.set(rule.category, rule);
    }
  }

  getRule(category: PersonalDataCategory): RetentionRule {
    const rule = this.rules.get(category);
    if (!rule) {
      throw new RetentionError(
        `No retention rule configured for category "${category}"`,
        "UNKNOWN_CATEGORY"
      );
    }
    return rule;
  }

  /** Add or override a retention rule for a category. */
  setRule(rule: RetentionRule): void {
    this.rules.set(rule.category, rule);
  }

  /**
   * Returns true when `record` is older than its category's retention period
   * relative to `now` (ISO 8601 UTC).
   */
  isPastRetention(record: PersonalRecord, now: string): boolean {
    const rule = this.getRule(record.category);
    const updatedMs = parseMs(record.updatedAt);
    const nowMs = parseMs(now);
    return nowMs - updatedMs > rule.retentionDays * 24 * 60 * 60 * 1000;
  }

  /** Returns the subset of `records` that are past retention as of `now`. */
  evaluateRetention(
    records: readonly PersonalRecord[],
    now: string
  ): PersonalRecord[] {
    return records.filter((r) => this.isPastRetention(r, now));
  }
}

/**
 * Manages personal records and performs auditable deletion. Deletions remove
 * the record from the store and append a deletion record to the audit log.
 */
export class RetentionManager {
  private policy: RetentionPolicy;
  private logger: AuditLogger;
  private clock: RetentionClock;
  private idGenerator: RetentionIdGenerator;
  private records: Map<string, PersonalRecord>;
  private deletions: DeletionRecord[];

  constructor(
    options: {
      policy?: RetentionPolicy;
      logger?: AuditLogger;
      clock?: RetentionClock;
      idGenerator?: RetentionIdGenerator;
    } = {}
  ) {
    this.policy = options.policy ?? new RetentionPolicy();
    this.logger = options.logger ?? new AuditLogger();
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new DefaultIdGenerator();
    this.records = new Map();
    this.deletions = [];
  }

  /** Stores a personal record (for test setup / ingestion). */
  addRecord(record: PersonalRecord): void {
    this.records.set(record.id, record);
  }

  /** Returns a copy of the stored record, or undefined when absent. */
  getRecord(recordId: string): PersonalRecord | undefined {
    const record = this.records.get(recordId);
    return record ? { ...record } : undefined;
  }

  /** Returns copies of all stored personal records. */
  listRecords(): PersonalRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  /** Returns copies of all deletion records (newest first). */
  listDeletions(): DeletionRecord[] {
    return [...this.deletions].reverse().map((d) => ({ ...d }));
  }

  /**
   * Returns the records eligible for deletion as of `now` without mutating
   * state.
   */
  eligibleForDeletion(now: string): PersonalRecord[] {
    return this.policy.evaluateRetention(this.listRecords(), now);
  }

  /**
   * Delete a personal record once it is past retention (or with an explicit
   * emergency override). Returns the deletion record. Throws RetentionError
   * when the record is missing or not yet past retention without an override.
   */
  scheduleDeletion(recordId: string, request: DeletionRequest): DeletionRecord {
    const record = this.records.get(recordId);
    if (!record) {
      throw new RetentionError(
        `Personal record not found: ${recordId}`,
        "RECORD_NOT_FOUND"
      );
    }

    const pastRetention = this.policy.isPastRetention(record, this.clock.now());
    if (!pastRetention && !request.emergencyOverride) {
      const rule = this.policy.getRule(record.category);
      throw new RetentionError(
        `Record "${recordId}" (${record.category}) is not past its ` +
          `${rule.retentionDays}-day retention period. ` +
          `Use emergencyOverride to force deletion.`,
        "NOT_PAST_RETENTION"
      );
    }

    const deletion: DeletionRecord = {
      id: this.idGenerator.next(),
      recordId: record.id,
      category: record.category,
      subjectId: record.subjectId,
      action: "DELETE",
      reason: request.reason,
      actor: request.actor,
      requestId: request.requestId,
      timestamp: this.clock.now(),
      emergencyOverride: !!request.emergencyOverride,
    };
    this.deletions.push(deletion);
    this.records.delete(recordId);

    // Audit the deletion without logging secrets.
    this.logger.record({
      actor: request.actor,
      actorRole: "admin",
      action: "delete.personal_record",
      target: `personal-record:${record.id}:${record.category}`,
      requestId: request.requestId,
      reason: request.reason,
      metadata: {
        recordId: record.id,
        category: record.category,
        subjectId: record.subjectId,
        emergencyOverride: deletion.emergencyOverride,
      },
    });

    return { ...deletion };
  }

  /**
   * Purges deletion records older than `cutoff` as part of audit-log retention.
   * Returns the number of deletion records removed.
   */
  purgeDeletionRecordsOlderThan(
    cutoff: string,
    _actor: string,
    _requestId: string
  ): number {
    const cutoffMs = parseMs(cutoff);
    const removed = this.deletions.filter(
      (d) => new Date(d.timestamp).getTime() < cutoffMs
    );
    this.deletions = this.deletions.filter(
      (d) => new Date(d.timestamp).getTime() >= cutoffMs
    );
    return removed.length;
  }
}

/**
 * Resolves envelope retention rules and evaluates which raw event envelopes
 * are past retention. Pure and deterministic given `now`.
 */
export class EnvelopeRetentionPolicy {
  private rules: Map<EnvelopeRetentionClass, EnvelopeRetentionRule>;

  constructor(rules: EnvelopeRetentionRule[] = DEFAULT_ENVELOPE_RETENTION_RULES) {
    this.rules = new Map();
    for (const rule of rules) {
      this.rules.set(rule.retentionClass, rule);
    }
  }

  getRule(retentionClass: EnvelopeRetentionClass): EnvelopeRetentionRule {
    const rule = this.rules.get(retentionClass);
    if (!rule) {
      throw new RetentionError(
        `No retention rule configured for envelope class "${retentionClass}"`,
        "UNKNOWN_ENVELOPE_CLASS"
      );
    }
    return rule;
  }

  setRule(rule: EnvelopeRetentionRule): void {
    this.rules.set(rule.retentionClass, rule);
  }

  /** Returns true when `envelope` is older than its class's retention period. */
  isPastRetention(envelope: RawEventEnvelope, now: string): boolean {
    const rule = this.getRule(envelope.retentionClass);
    const updatedMs = parseMs(envelope.updatedAt);
    const nowMs = parseMs(now);
    return nowMs - updatedMs > rule.retentionDays * 24 * 60 * 60 * 1000;
  }

  /** Returns the subset of `envelopes` that are past retention as of `now`. */
  evaluateEnvelopeRetention(
    envelopes: readonly RawEventEnvelope[],
    now: string
  ): RawEventEnvelope[] {
    return envelopes.filter((e) => this.isPastRetention(e, now));
  }

  /**
   * Returns a copy of `envelope` with personal fields redacted when its class
   * requires it. Integrity fields (hash, source ref) are always preserved.
   */
  redactForArchival(envelope: RawEventEnvelope): RawEventEnvelope {
    const rule = this.getRule(envelope.retentionClass);
    const copy: RawEventEnvelope = {
      ...envelope,
      derivedRecordIds: [...envelope.derivedRecordIds],
    };
    if (rule.redactPersonalFields) {
      delete copy.personalFields;
    } else if (envelope.personalFields) {
      copy.personalFields = { ...envelope.personalFields };
    }
    return copy;
  }
}

/**
 * Manages raw event envelopes and performs auditable, idempotent purges.
 *
 * Purge ordering guarantees (issues #223 / #224):
 * - An envelope is only removed once every derived record is archived.
 * - Personal fields are redacted before archival per the retention class.
 * - Every purge (and every blocked attempt) is recorded via the audit logger.
 * - Purges are idempotent: re-running after success is a no-op.
 */
export class EnvelopeRetentionManager {
  private policy: EnvelopeRetentionPolicy;
  private logger: AuditLogger;
  private clock: RetentionClock;
  private envelopes: Map<string, RawEventEnvelope>;
  private archivedDerived: Set<string>;
  private archivedEnvelopes: Map<string, RawEventEnvelope>;
  private authorizedActors: Set<string>;

  constructor(
    options: {
      policy?: EnvelopeRetentionPolicy;
      logger?: AuditLogger;
      clock?: RetentionClock;
      /** Actors permitted to purge envelopes. Defaults to empty (deny all). */
      authorizedActors?: Iterable<string>;
    } = {}
  ) {
    this.policy = options.policy ?? new EnvelopeRetentionPolicy();
    this.logger = options.logger ?? new AuditLogger();
    this.clock = options.clock ?? new SystemClock();
    this.envelopes = new Map();
    this.archivedDerived = new Set();
    this.archivedEnvelopes = new Map();
    this.authorizedActors = new Set(options.authorizedActors ?? []);
  }

  /** Stores a raw event envelope (for ingestion / test setup). */
  addEnvelope(envelope: RawEventEnvelope): void {
    this.envelopes.set(envelope.id, {
      ...envelope,
      derivedRecordIds: [...envelope.derivedRecordIds],
      personalFields: envelope.personalFields
        ? { ...envelope.personalFields }
        : undefined,
    });
  }

  /** Returns a copy of the stored envelope, or undefined when absent. */
  getEnvelope(envelopeId: string): RawEventEnvelope | undefined {
    const envelope = this.envelopes.get(envelopeId);
    return envelope ? this.policy.redactForArchival(envelope) : undefined;
  }

  /** Returns copies of all stored envelopes (personal fields redacted). */
  listEnvelopes(): RawEventEnvelope[] {
    return [...this.envelopes.values()].map((e) =>
      this.policy.redactForArchival(e)
    );
  }

  /** Returns copies of archived envelopes (newest first). */
  listArchivedEnvelopes(): RawEventEnvelope[] {
    return [...this.archivedEnvelopes.values()]
      .reverse()
      .map((e) => this.policy.redactForArchival(e));
  }

  /** Marks a derived record as archived, unblocking its envelope's purge. */
  markDerivedRecordArchived(derivedRecordId: string): void {
    this.archivedDerived.add(derivedRecordId);
  }

  /** Returns the envelopes eligible for purge as of `now` without mutating. */
  evaluateEnvelopeRetention(now: string): RawEventEnvelope[] {
    return this.policy.evaluateEnvelopeRetention(this.listEnvelopes(), now);
  }

  private assertAuthorized(actor: string): void {
    if (!this.authorizedActors.has(actor)) {
      throw new EnvelopeAuthorizationError(
        `Actor "${actor}" is not authorized to purge raw event envelopes`
      );
    }
  }

  /**
   * Purges expired envelopes whose derived records are all archived.
   *
   * Idempotent: envelopes already purged are treated as success and the call
   * returns `idempotent: true` when nothing remained to purge. Envelopes with
   * unarchived derived records are reported in `blocked` and retained.
   */
  purgeExpiredEnvelopes(
    request: { actor: string; requestId: string; reason?: string },
    now: string = this.clock.now()
  ): EnvelopePurgeResult {
    this.assertAuthorized(request.actor);
    const nowMs = parseMs(now);

    const result: EnvelopePurgeResult = {
      purged: [],
      blocked: [],
      retained: [],
      idempotent: false,
    };

    for (const envelope of [...this.envelopes.values()]) {
      if (!this.policy.isPastRetention(envelope, now)) {
        result.retained.push(envelope.id);
        continue;
      }

      const unarchived = envelope.derivedRecordIds.filter(
        (id) => !this.archivedDerived.has(id)
      );
      if (unarchived.length > 0) {
        result.blocked.push(envelope.id);
        this.logger.record({
          actor: request.actor,
          actorRole: "admin",
          action: "purge.raw_event_envelope.blocked",
          target: `raw-event-envelope:${envelope.id}:${envelope.retentionClass}`,
          requestId: request.requestId,
          reason:
            request.reason ??
            "Derived records not yet archived; envelope retained.",
          metadata: {
            envelopeId: envelope.id,
            retentionClass: envelope.retentionClass,
            unarchivedDerivedRecordIds: unarchived,
          },
        });
        continue;
      }

      // Archive a redacted copy, then remove the live envelope.
      const archived = this.policy.redactForArchival(envelope);
      this.archivedEnvelopes.set(envelope.id, archived);
      this.envelopes.delete(envelope.id);
      result.purged.push(envelope.id);

      this.logger.record({
        actor: request.actor,
        actorRole: "admin",
        action: "purge.raw_event_envelope",
        target: `raw-event-envelope:${envelope.id}:${envelope.retentionClass}`,
        requestId: request.requestId,
        reason: request.reason ?? "Envelope past retention; archived and purged.",
        metadata: {
          envelopeId: envelope.id,
          retentionClass: envelope.retentionClass,
          subjectId: envelope.subjectId,
          contentHash: envelope.contentHash,
          redacted: !archived.personalFields,
          purgedAt: new Date(nowMs).toISOString(),
        },
      });
    }

    result.idempotent = result.purged.length === 0 && result.blocked.length === 0;
    return result;
  }
}
