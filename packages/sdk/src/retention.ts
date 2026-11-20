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

/**
 * Retention class of a raw event envelope — issues #223 / #224.
 *
 * Envelopes are the integrity-checkable source of derived records. They are
 * retained only as long as needed for auditability, then compacted/archived.
 */
export type EnvelopeRetentionClass =
  | "ephemeral"
  | "operational"
  | "audit"
  | "legal";

/**
 * Minimal raw event envelope retained for auditability (issue #223).
 *
 * The envelope carries only what is needed to integrity-check derived records
 * (a content hash and the source reference) plus a small, redactable payload.
 * It never stores secrets; personal fields are redacted before archival.
 */
export interface RawEventEnvelope {
  id: string;
  /** Retention class driving how long the envelope is kept. */
  retentionClass: EnvelopeRetentionClass;
  /** Public subject identifier (e.g. wallet address). Never a secret. */
  subjectId: string;
  /** Reference to the source event (e.g. chain tx / log id). */
  sourceRef: string;
  /** Integrity hash of the original event payload (hex). */
  contentHash: string;
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
  /**
   * Derived record ids that were produced from this envelope. An envelope may
   * only be purged once every derived record has been archived.
   */
  derivedRecordIds: string[];
  /**
   * Personal fields captured from the event. These are redacted (dropped)
   * before archival when the retention class requires it.
   */
  personalFields?: Record<string, string>;
}

/** Retention rule for a raw event envelope class. */
export interface EnvelopeRetentionRule {
  retentionClass: EnvelopeRetentionClass;
  /** Retention period in days. */
  retentionDays: number;
  /** When true, personal fields are redacted before archival. */
  redactPersonalFields: boolean;
  description: string;
}

/** Default retention periods per envelope class. */
export const DEFAULT_ENVELOPE_RETENTION_RULES: EnvelopeRetentionRule[] = [
  {
    retentionClass: "ephemeral",
    retentionDays: 7,
    redactPersonalFields: true,
    description:
      "High-volume events kept briefly for troubleshooting, then dropped.",
  },
  {
    retentionClass: "operational",
    retentionDays: 30,
    redactPersonalFields: true,
    description:
      "Operational events retained for incident review with personal fields redacted.",
  },
  {
    retentionClass: "audit",
    retentionDays: 365,
    redactPersonalFields: true,
    description:
      "Audit-relevant events retained for a year with personal fields redacted.",
  },
  {
    retentionClass: "legal",
    retentionDays: 2555, // 7 years
    redactPersonalFields: false,
    description:
      "Legal-hold events retained for the statutory window, unredacted.",
  },
];

/** Result of a single envelope purge attempt. */
export interface EnvelopePurgeResult {
  /** Envelopes removed (or already absent) in this call. */
  purged: string[];
  /** Envelopes skipped because derived records are not yet archived. */
  blocked: string[];
  /** Envelopes skipped because they are not yet past retention. */
  retained: string[];
  /** True when the call was a no-op retry (nothing left to purge). */
  idempotent: boolean;
}

/** Error raised when an actor is not authorized to purge envelopes. */
export class EnvelopeAuthorizationError extends RetentionError {
  constructor(message: string) {
    super(message, "UNAUTHORIZED");
    this.name = "EnvelopeAuthorizationError";
    Object.setPrototypeOf(this, EnvelopeAuthorizationError.prototype);
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
