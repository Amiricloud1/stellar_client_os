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
  | "modify.configuration"
  | "delete.personal_record"
  | "export.personal_data"
  | "modify.retention_policy"
  | "create.reviewer_comment"
  | "resolve.reviewer_comment";

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
        action === "delete.personal_record" ||
        action === "create.reviewer_comment" ||
        action === "resolve.reviewer_comment"
      );
    }
    // auditor and viewer may not perform any privileged write action.
    return false;
  },
};

const SECRET_KEY_PATTERN =
  /(secret|token|password|passphrase|credential|private.?key|api.?key|authorization|dsn)/i;

const STELLAR_SECRET_KEY_PREFIX = "S";

/**
 * Redacts secret-looking keys from metadata so audit records never store
 * credentials, private keys, or tokens.
 */
export function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!metadata) return {};
  const ancestors = new WeakSet<object>();

  const sanitizeValue = (value: unknown, key?: string): unknown => {
    if (key && SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";
    if (
      typeof value === "string" &&
      value.startsWith(STELLAR_SECRET_KEY_PREFIX) &&
      value.length === 56
    ) {
      return "[REDACTED]";
    }
    if (Array.isArray(value)) {
      if (ancestors.has(value)) return "[CIRCULAR]";
      ancestors.add(value);
      const sanitized = value.map((item) => sanitizeValue(item));
      ancestors.delete(value);
      return sanitized;
    }
    if (value !== null && typeof value === "object") {
      if (ancestors.has(value)) return "[CIRCULAR]";
      ancestors.add(value);
      const sanitized = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
          childKey,
          sanitizeValue(childValue, childKey),
        ]),
      );
      ancestors.delete(value);
      return sanitized;
    }
    return value;
  };

  return sanitizeValue(metadata) as Record<string, unknown>;
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

/**
 * Error raised when a raw event envelope fails integrity verification or when
 * an envelope cannot be created/read under the retention and privacy rules.
 */
export class EnvelopeIntegrityError extends AuditError {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = "EnvelopeIntegrityError";
    Object.setPrototypeOf(this, EnvelopeIntegrityError.prototype);
  }
}

/** Retention class assigned to a raw event envelope. */
export type RetentionClass = "short" | "standard" | "extended";

/** Privacy flags describing what was redacted from the raw payload. */
export interface PrivacyFlags {
  /** True when secret-looking fields were redacted from the payload. */
  redacted: boolean;
  /** Keys that were redacted (never the values). */
  redactedKeys: string[];
  /** True when the payload was truncated to fit the size limit. */
  truncated: boolean;
}

/**
 * Minimal, integrity-checkable envelope retained for auditability. Derived
 * records link back to a source envelope via `eventId`; the envelope stores a
 * stable SHA-256 hash of the (redacted) payload so tampering is detectable.
 */
export interface RawEventEnvelope {
  /** Stable, caller-supplied id used for idempotent writes. */
  eventId: string;
  /** Source system that produced the event (e.g. "indexer", "api"). */
  source: string;
  /** Ledger sequence the event belongs to, when known. */
  ledger: number | null;
  /** ISO 8601 UTC timestamp of the source event. */
  timestamp: string;
  /** SHA-256 hex digest of the canonical redacted payload. */
  payloadHash: string;
  /** Retention class controlling how long the envelope is kept. */
  retentionClass: RetentionClass;
  /** Privacy flags describing redaction applied to the payload. */
  privacyFlags: PrivacyFlags;
  /** Redacted payload retained for auditability. */
  redactedPayload: Record<string, unknown>;
}

/** Input accepted by {@link createRawEventEnvelope}. */
export interface RawEventEnvelopeInput {
  eventId: string;
  source: string;
  ledger?: number | null;
  timestamp?: string;
  payload?: Record<string, unknown>;
  retentionClass?: RetentionClass;
}

/** Maximum serialized payload size (in bytes) retained in an envelope. */
export const MAX_ENVELOPE_PAYLOAD_BYTES = 16 * 1024;

/** Default retention class when the caller does not specify one. */
export const DEFAULT_RETENTION_CLASS: RetentionClass = "standard";

/**
 * Deterministic JSON serialization with sorted keys so the payload hash is
 * stable regardless of object key insertion order.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    .join(",")}}`;
}

/** Computes the stable SHA-256 hex digest of a canonicalized payload. */
export function hashEnvelopePayload(payload: Record<string, unknown>): string {
  const canonical = canonicalize(payload);
  // Pure-JS SHA-256 (synchronous, dependency-free) so the SDK works in any
  // runtime without relying on WebCrypto's async API.
  return sha256Hex(canonical);
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Hex(message: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < message.length; i++) {
    const code = message.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0xd800 || code >= 0xe000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    } else {
      // Surrogate pair.
      const next = message.charCodeAt(++i);
      const cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    }
  }

  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit big-endian length (high 32 bits are zero for our sizes).
  bytes.push(0, 0, 0, 0);
  bytes.push(
    (bitLength >>> 24) & 0xff,
    (bitLength >>> 16) & 0xff,
    (bitLength >>> 8) & 0xff,
    bitLength & 0xff
  );

  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Array<number>(64);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] =
        ((bytes[j] << 24) |
          (bytes[j + 1] << 16) |
          (bytes[j + 2] << 8) |
          bytes[j + 3]) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 =
        (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 =
        (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  return h.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotr(value: number, shift: number): number {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

/**
 * Creates a minimal raw event envelope: applies privacy redaction to the
 * payload, enforces the size limit, computes a stable SHA-256 payload hash and
 * assigns a retention class.
 *
 * @throws EnvelopeIntegrityError("MISSING_EVENT_ID") when `eventId` is empty.
 * @throws EnvelopeIntegrityError("MISSING_SOURCE") when `source` is empty.
 * @throws EnvelopeIntegrityError("PAYLOAD_TOO_LARGE") when the redacted payload
 *   exceeds {@link MAX_ENVELOPE_PAYLOAD_BYTES}.
 */
export function createRawEventEnvelope(
  input: RawEventEnvelopeInput,
  clock: Clock = new SystemClock()
): RawEventEnvelope {
  if (!input.eventId || input.eventId.trim() === "") {
    throw new EnvelopeIntegrityError(
      "Envelope eventId is required",
      "MISSING_EVENT_ID"
    );
  }
  if (!input.source || input.source.trim() === "") {
    throw new EnvelopeIntegrityError(
      "Envelope source is required",
      "MISSING_SOURCE"
    );
  }

  const rawPayload = input.payload ?? {};
  const redactedPayload = sanitizeMetadata(rawPayload);
  const redactedKeys = Object.keys(rawPayload).filter(
    (key) => redactedPayload[key] === "[REDACTED]"
  );

  const serialized = canonicalize(redactedPayload);
  const byteLength = new TextEncoder().encode(serialized).length;
  if (byteLength > MAX_ENVELOPE_PAYLOAD_BYTES) {
    throw new EnvelopeIntegrityError(
      `Envelope payload exceeds ${MAX_ENVELOPE_PAYLOAD_BYTES} bytes`,
      "PAYLOAD_TOO_LARGE"
    );
  }

  return {
    eventId: input.eventId,
    source: input.source,
    ledger: input.ledger ?? null,
    timestamp: input.timestamp ?? clock.now(),
    payloadHash: hashEnvelopePayload(redactedPayload),
    retentionClass: input.retentionClass ?? DEFAULT_RETENTION_CLASS,
    privacyFlags: {
      redacted: redactedKeys.length > 0,
      redactedKeys,
      truncated: false,
    },
    redactedPayload,
  };
}

/**
 * Recomputes the payload hash and rejects envelopes whose payload was tampered
 * with after creation.
 *
 * @throws EnvelopeIntegrityError("HASH_MISMATCH") when the recomputed hash does
 *   not match `payloadHash`.
 */
export function verifyRawEventEnvelope(envelope: RawEventEnvelope): boolean {
  const recomputed = hashEnvelopePayload(envelope.redactedPayload);
  if (recomputed !== envelope.payloadHash) {
    throw new EnvelopeIntegrityError(
      `Envelope "${envelope.eventId}" failed integrity verification`,
      "HASH_MISMATCH"
    );
  }
  return true;
}

/**
 * Append-only store for raw event envelopes. Writes are idempotent on
 * `eventId`: retrying the same event returns the previously stored envelope
 * instead of creating a duplicate.
 */
export class RawEventEnvelopeStore {
  private envelopes = new Map<string, RawEventEnvelope>();

  /**
   * Stores an envelope idempotently. If an envelope with the same `eventId`
   * already exists it is returned unchanged (retries do not duplicate).
   */
  put(envelope: RawEventEnvelope): RawEventEnvelope {
    const existing = this.envelopes.get(envelope.eventId);
    if (existing) return existing;
    verifyRawEventEnvelope(envelope);
    this.envelopes.set(envelope.eventId, envelope);
    return envelope;
  }

  /** Creates and stores an envelope in one step (idempotent on eventId). */
  create(
    input: RawEventEnvelopeInput,
    clock: Clock = new SystemClock()
  ): RawEventEnvelope {
    const existing = this.envelopes.get(input.eventId);
    if (existing) return existing;
    return this.put(createRawEventEnvelope(input, clock));
  }

  /**
   * Reads an envelope by id. Requires an oversight role (admin or auditor);
   * operators and viewers may not read raw envelopes.
   *
   * @throws AuditError("ACCESS_DENIED") when the role is not permitted.
   * @throws EnvelopeIntegrityError("ENVELOPE_NOT_FOUND") when missing.
   */
  get(eventId: string, role: ActorRole): RawEventEnvelope {
    if (role !== "admin" && role !== "auditor") {
      throw new AuditError(
        `Role "${role}" is not authorized to read raw event envelopes`,
        "ACCESS_DENIED"
      );
    }
    const envelope = this.envelopes.get(eventId);
    if (!envelope) {
      throw new EnvelopeIntegrityError(
        `Envelope "${eventId}" not found`,
        "ENVELOPE_NOT_FOUND"
      );
    }
    return envelope;
  }

  /** Returns the number of stored envelopes. */
  count(): number {
    return this.envelopes.size;
  }

  /**
   * Removes envelopes whose retention class has expired relative to `cutoff`.
   * Returns the number of envelopes removed.
   */
  purgeExpired(cutoff: string): number {
    const cutoffTime = new Date(cutoff).getTime();
    if (Number.isNaN(cutoffTime)) {
      throw new AuditError("Invalid cutoff timestamp", "INVALID_CUTOFF");
    }
    let removed = 0;
    for (const [eventId, envelope] of this.envelopes) {
      if (new Date(envelope.timestamp).getTime() < cutoffTime) {
        this.envelopes.delete(eventId);
        removed++;
      }
    }
    return removed;
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
    if (input.action === "modify.configuration" && !input.reason?.trim()) {
      throw new AuditError(
        "Configuration changes require a non-empty audit reason",
        "REASON_REQUIRED"
      );
    }
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

  /** Records a configuration change with redacted before/after evidence. */
  recordConfigurationChange(
    input: Omit<AuditRecordParams, "action" | "metadata"> & {
      target: string;
      setting: string;
      before: unknown;
      after: unknown;
      reason: string;
    }
  ): AuditRecord {
    if (!input.setting.trim()) {
      throw new AuditError(
        "Configuration changes require a setting name",
        "SETTING_REQUIRED"
      );
    }
    const { setting, before, after, ...recordInput } = input;
    const sensitiveSetting = SECRET_KEY_PATTERN.test(setting);
    return this.record({
      ...recordInput,
      action: "modify.configuration",
      metadata: {
        setting,
        before: sensitiveSetting ? "[REDACTED]" : before,
        after: sensitiveSetting ? "[REDACTED]" : after,
      },
    });
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
