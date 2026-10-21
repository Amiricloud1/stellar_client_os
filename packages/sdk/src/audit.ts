/**
 * Privileged administrative action audit logging — issue #109
 *
 * Records actor, action, target, timestamp, and request ID for every
 * privileged operation without ever logging secrets. Enforces role-based
 * access and retains audit entries for a configurable period so operator
 * accountability can be verified with positive and negative tests.
 *
 * All timestamps are ISO 8601 UTC. All identifiers are public (wallet
 * addresses, request IDs, action names) — secrets must never be placed in
 * `metadata`; `sanitizeMetadata` redacts any secret-looking keys automatically.
 */

export type AuditOutcome = "ALLOWED" | "DENIED";

export type AuditAction =
  | "deploy.contract"
  | "initialize.contract"
  | "rotate.credential"
  | "delete.personal_record"
  | "export.personal_data"
  | "modify.retention_policy";

export type ActorRole = "admin" | "operator" | "auditor" | "viewer";

export interface AuditRecordParams {
  /** Public identifier of the actor (wallet address or service account). */
  actor: string;
  /** Role of the actor at the time of the action. */
  actorRole: ActorRole;
  /** Privileged action being attempted. */
  action: AuditAction;
  /** Target of the action (contract id, record id, credential id, etc.). */
  target: string;
  /** Correlation id for the request, provided by the caller. */
  requestId: string;
  /** Additional context. Secrets are redacted before being stored. */
  metadata?: Record<string, unknown>;
  /** Whether the action was allowed or denied. Defaults to "ALLOWED". */
  outcome?: AuditOutcome;
  /** Human-readable reason, populated on denial or override. */
  reason?: string;
}

/** Alias kept for backwards compatibility with earlier drafts. */
export type AuditEventInput = AuditRecordParams;

export interface AuditRecord extends AuditRecordParams {
  /** Server-assigned unique id for the audit entry. */
  id: string;
  /** ISO 8601 UTC timestamp of when the event was recorded. */
  timestamp: string;
  /** Whether the action was allowed or denied. */
  outcome: AuditOutcome;
  /** Human-readable reason, populated on denial or override. */
  reason?: string;
}

export interface AccessPolicy {
  /**
   * Returns true when the given role is permitted to perform the action.
   * Implementations must be stateless and deterministic.
   */
  can(role: ActorRole, action: AuditAction): boolean;
}

/**
 * Default least-privilege access policy.
 *
 * - admin: every privileged action
 * - operator: deploy, initialize, rotate credential, delete personal record
 *   (operators may not export personal data or modify retention policy)
 * - auditor: no write actions (read-only oversight)
 * - viewer: no write actions (read-only oversight)
 */
export const DEFAULT_ACCESS_POLICY: AccessPolicy = {
  can(role: ActorRole, action: AuditAction): boolean {
    if (role === "admin") return true;
    if (role === "operator") {
      return (
        action === "deploy.contract" ||
        action === "initialize.contract" ||
        action === "rotate.credential" ||
        action === "delete.personal_record"
      );
    }
    // auditor and viewer may not perform any privileged write action.
    return false;
  },
};

const SECRET_KEY_PATTERNS = [
  // Standalone secret/credential/token/password key names.
  /(secret|token|password|passphrase|credential)$/i,
  // *-key forms such as secretKey, apiKey, privateKey, credentialKey.
  /(private|api|secret|credential).?key$/i,
];

const STELLAR_SECRET_KEY_PREFIX = "S";

/**
 * Redacts secret-looking keys from metadata so audit records never store
 * credentials, private keys, or tokens.
 */
export function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!metadata) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      sanitized[key] = "[REDACTED]";
    } else if (
      typeof value === "string" &&
      value.startsWith(STELLAR_SECRET_KEY_PREFIX) &&
      value.length === 56
    ) {
      // Looks like a Stellar secret key (starts with 'S', 56 chars).
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/** Error raised by the audit subsystem. */
export class AuditError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "AuditError";
    this.code = code;
    Object.setPrototypeOf(this, AuditError.prototype);
  }
}

/** Generates audit entry ids. Override for deterministic tests. */
export interface IdGenerator {
  next(): string;
}

class DefaultIdGenerator implements IdGenerator {
  private counter = 0;
  next(): string {
    return `audit-${Date.now()}-${++this.counter}`;
  }
}

/** Clock provider. Override for deterministic tests. */
export interface Clock {
  now(): string;
}

class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

/**
 * Options accepted by {@link AuditLogger}. Override the id generator and/or
 * clock for deterministic tests.
 */
export interface AuditLoggerOptions {
  idGenerator?: IdGenerator;
  clock?: Clock;
}

/**
 * Append-only audit log. Entries are never updated in place; expired entries
 * are removed only through `purgeOlderThan`, which itself is audited.
 */
export class AuditLogger {
  private entries: AuditRecord[] = [];
  private idGenerator: IdGenerator;
  private clock: Clock;

  constructor(options: AuditLoggerOptions = {}) {
    this.idGenerator = options.idGenerator ?? new DefaultIdGenerator();
    this.clock = options.clock ?? new SystemClock();
  }

  /** Record an audit event and return the stored record. */
  record(input: AuditRecordParams): AuditRecord {
    const record: AuditRecord = {
      ...input,
      id: this.idGenerator.next(),
      timestamp: this.clock.now(),
      outcome: input.outcome ?? "ALLOWED",
      metadata: sanitizeMetadata(input.metadata),
    };
    this.entries.push(record);
    return record;
  }

  /** Returns a copy of all stored audit records (newest first). */
  list(): AuditRecord[] {
    return [...this.entries].reverse();
  }

  /** Returns records matching the given predicate. */
  find(predicate: (record: AuditRecord) => boolean): AuditRecord[] {
    return this.entries.filter(predicate);
  }

  findByActor(actor: string): AuditRecord[] {
    return this.find((r) => r.actor === actor);
  }

  findByAction(action: AuditAction): AuditRecord[] {
    return this.find((r) => r.action === action);
  }

  findByTarget(target: string): AuditRecord[] {
    return this.find((r) => r.target === target);
  }

  findByRequestId(requestId: string): AuditRecord[] {
    return this.find((r) => r.requestId === requestId);
  }

  /** Returns the count of records stored. */
  count(): number {
    return this.entries.length;
  }

  /**
   * Removes records older than `cutoff` (ISO 8601 UTC) as a retention purge.
   * The purge itself is recorded as an audit entry so retention enforcement is
   * auditable. Returns the number of records removed.
   */
  purgeOlderThan(cutoff: string, actor: string, requestId: string): number {
    const cutoffTime = new Date(cutoff).getTime();
    if (Number.isNaN(cutoffTime)) {
      throw new AuditError("Invalid cutoff timestamp", "INVALID_CUTOFF");
    }

    const removed = this.entries.filter(
      (r) => new Date(r.timestamp).getTime() < cutoffTime
    );
    this.entries = this.entries.filter(
      (r) => new Date(r.timestamp).getTime() >= cutoffTime
    );

    this.record({
      actor,
      actorRole: "admin",
      action: "modify.retention_policy",
      target: `audit-log:purge-before-${cutoff}`,
      requestId,
      reason: `Retention purge removed ${removed.length} entries before ${cutoff}`,
      metadata: { removedCount: removed.length },
    });

    return removed.length;
  }
}

/**
 * Enforces role-based access for privileged actions. Throws on denial so
 * callers cannot accidentally perform an unauthorized action.
 */
export class AccessController {
  private policy: AccessPolicy;

  constructor(policy: AccessPolicy = DEFAULT_ACCESS_POLICY) {
    this.policy = policy;
  }

  /** Returns true when the role may perform the action. */
  isAllowed(role: ActorRole, action: AuditAction): boolean {
    return this.policy.can(role, action);
  }

  /** Throws AuditError("ACCESS_DENIED") when the role may not perform the action. */
  enforce(role: ActorRole, action: AuditAction): void {
    if (!this.policy.can(role, action)) {
      throw new AuditError(
        `Role "${role}" is not authorized to perform "${action}"`,
        "ACCESS_DENIED"
      );
    }
  }
}

/**
 * Convenience wrapper that enforces access, executes a privileged operation,
 * and audits the actor, action, target, timestamp, and request ID regardless
 * of outcome. Secrets in `metadata` are redacted automatically.
 */
export class PrivilegedActionRecorder {
  private accessController: AccessController;
  private logger: AuditLogger;

  constructor(
    accessController: AccessController = new AccessController(),
    logger: AuditLogger = new AuditLogger()
  ) {
    this.accessController = accessController;
    this.logger = logger;
  }

  /**
   * Execute a privileged operation under audit.
   *
   * @returns the operation's result when allowed.
   * @throws AuditError("ACCESS_DENIED") when the actor lacks permission; the
   *   denial is still audited before the error propagates.
   * @throws any error thrown by `operation`; the failure is audited as DENIED.
   */
  async execute<T>(
    input: AuditRecordParams & { role?: ActorRole },
    operation: () => Promise<T> | T
  ): Promise<T> {
    const role = input.role ?? input.actorRole;
    const resolvedAction = input.action;

    // Enforce access first; record the denial regardless of outcome.
    try {
      this.accessController.enforce(role, resolvedAction);
    } catch (err) {
      this.logger.record({
        ...input,
        actorRole: role,
        action: resolvedAction,
        outcome: "DENIED",
        reason: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    let result: T;
    try {
      result = await operation();
    } catch (err) {
      this.logger.record({
        ...input,
        actorRole: role,
        action: resolvedAction,
        outcome: "DENIED",
        reason: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    this.logger.record({
      ...input,
      actorRole: role,
      action: resolvedAction,
      outcome: "ALLOWED",
    });
    return result;
  }

  /** Returns the underlying audit log for inspection. */
  getLogger(): AuditLogger {
    return this.logger;
  }
}
