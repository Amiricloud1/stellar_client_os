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
