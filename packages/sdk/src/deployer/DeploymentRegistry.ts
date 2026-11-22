import { Address } from '@stellar/stellar-sdk';

/**
 * Lifecycle states a deployment record may be in.
 *
 * - `pending`     – deployment transaction submitted but not yet confirmed.
 * - `active`      – deployment confirmed and live.
 * - `failed`      – deployment failed; may be retried.
 * - `deprecated`  – deployment superseded but still resolvable.
 * - `rolled_back` – deployment reverted; no longer live.
 */
export type DeploymentLifecycleState =
  | 'pending'
  | 'active'
  | 'failed'
  | 'deprecated'
  | 'rolled_back';

const LIFECYCLE_STATES: ReadonlySet<DeploymentLifecycleState> = new Set([
  'pending',
  'active',
  'failed',
  'deprecated',
  'rolled_back',
]);

/**
 * Allowed lifecycle transitions. Any transition not listed here is rejected.
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<DeploymentLifecycleState, ReadonlySet<DeploymentLifecycleState>>
> = {
  pending: new Set(['active', 'failed']),
  active: new Set(['deprecated', 'rolled_back', 'failed']),
  failed: new Set(['pending', 'active', 'rolled_back']),
  deprecated: new Set(['rolled_back']),
  rolled_back: new Set([]),
};

/**
 * A validated contract deployment record.
 */
export interface DeploymentRecord {
  /** Logical environment name, e.g. `testnet`, `mainnet`, `staging`. */
  environment: string;
  /** Stellar network identifier, e.g. `testnet`, `mainnet`, or a passphrase. */
  network: string;
  /** Contract address (C...). */
  address: string;
  /** Ledger sequence at which the deployment was confirmed. */
  ledger: number;
  /** Semantic version of the contract spec deployed. */
  specVersion: string;
  /** Current lifecycle state. */
  state: DeploymentLifecycleState;
  /** Optional free-form metadata. */
  metadata?: Record<string, unknown>;
  /** ISO timestamp of when the record was created. */
  createdAt: string;
  /** ISO timestamp of the last update. */
  updatedAt: string;
}

/**
 * Input accepted by {@link DeploymentRegistry.recordDeployment}.
 */
export interface DeploymentRecordInput {
  environment: string;
  network: string;
  address: string;
  ledger: number;
  specVersion: string;
  state?: DeploymentLifecycleState;
  metadata?: Record<string, unknown>;
}

/**
 * Pluggable persistence backend for deployment records.
 *
 * Implementations may be in-memory, backed by a database, or remote.
 * All methods may throw to signal transient failures; the registry will
 * surface these via {@link DeploymentRegistryError} with `retryable: true`.
 */
export interface DeploymentStore {
  get(key: string): Promise<DeploymentRecord | undefined>;
  put(key: string, record: DeploymentRecord): Promise<void>;
  listByEnvironment(environment: string): Promise<DeploymentRecord[]>;
}

/**
 * Authorization hook invoked before any write.
 *
 * Return `true` to allow, `false` to deny. May throw to signal an
 * authorization backend failure (treated as a non-retryable denial).
 */
export type DeploymentAuthorizer = (action: {
  type: 'record' | 'transition';
  environment: string;
  network: string;
  address: string;
}) => boolean | Promise<boolean>;

/**
 * Error codes surfaced by the registry.
 */
export type DeploymentRegistryErrorCode =
  | 'invalid_record'
  | 'invalid_transition'
  | 'unauthorized'
  | 'not_found'
  | 'storage_failure';

/**
 * Explicit error type for all registry failures.
 *
 * `retryable` indicates whether the caller may safely retry the operation
 * (e.g. after a transient storage failure).
 */
export class DeploymentRegistryError extends Error {
  readonly code: DeploymentRegistryErrorCode;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(
    code: DeploymentRegistryErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'DeploymentRegistryError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}

/**
 * In-memory {@link DeploymentStore} implementation. Useful for tests and
 * local development.
 */
export class InMemoryDeploymentStore implements DeploymentStore {
  private readonly records = new Map<string, DeploymentRecord>();

  async get(key: string): Promise<DeploymentRecord | undefined> {
    return this.records.get(key);
  }

  async put(key: string, record: DeploymentRecord): Promise<void> {
    this.records.set(key, record);
  }

  async listByEnvironment(environment: string): Promise<DeploymentRecord[]> {
    const out: DeploymentRecord[] = [];
    for (const record of this.records.values()) {
      if (record.environment === environment) {
        out.push(record);
      }
    }
    return out;
  }
}

export interface DeploymentRegistryOptions {
  store?: DeploymentStore;
  authorizer?: DeploymentAuthorizer;
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function recordKey(environment: string, network: string, address: string): string {
  return `${environment}:${network}:${address}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidAddress(address: string): boolean {
  try {
    const parsed = new Address(address);
    return parsed.toString() === address;
  } catch {
    return false;
  }
}

/**
 * Validates a record input, throwing {@link DeploymentRegistryError} with
 * code `invalid_record` on failure.
 */
function validateInput(input: DeploymentRecordInput): void {
  if (!isNonEmptyString(input.environment)) {
    throw new DeploymentRegistryError(
      'invalid_record',
      'environment must be a non-empty string',
    );
  }
  if (!isNonEmptyString(input.network)) {
    throw new DeploymentRegistryError(
      'invalid_record',
      'network must be a non-empty string',
    );
  }
  if (!isNonEmptyString(input.address) || !isValidAddress(input.address)) {
    throw new DeploymentRegistryError(
      'invalid_record',
      `address must be a valid Stellar contract address, got ${String(input.address)}`,
    );
  }
  if (
    typeof input.ledger !== 'number' ||
    !Number.isInteger(input.ledger) ||
    input.ledger < 0
  ) {
    throw new DeploymentRegistryError(
      'invalid_record',
      `ledger must be a non-negative integer, got ${String(input.ledger)}`,
    );
  }
  if (!isNonEmptyString(input.specVersion) || !SEMVER_RE.test(input.specVersion)) {
    throw new DeploymentRegistryError(
      'invalid_record',
      `specVersion must be a semantic version, got ${String(input.specVersion)}`,
    );
  }
  if (input.state !== undefined && !LIFECYCLE_STATES.has(input.state)) {
    throw new DeploymentRegistryError(
      'invalid_record',
      `state must be one of ${[...LIFECYCLE_STATES].join(', ')}, got ${String(input.state)}`,
    );
  }
}

/**
 * Validates a stored record on read, throwing {@link DeploymentRegistryError}
 * with code `invalid_record` if the persisted data is corrupt.
 */
function validateStoredRecord(record: DeploymentRecord): void {
  validateInput(record);
  if (!LIFECYCLE_STATES.has(record.state)) {
    throw new DeploymentRegistryError(
      'invalid_record',
      `stored record has invalid state ${String(record.state)}`,
    );
  }
  if (!isNonEmptyString(record.createdAt) || !isNonEmptyString(record.updatedAt)) {
    throw new DeploymentRegistryError(
      'invalid_record',
      'stored record is missing timestamps',
    );
  }
}

/**
 * Registry of validated contract deployments.
 *
 * Records are validated on write and on read. Writes are gated by an
 * injected {@link DeploymentAuthorizer}. Storage failures are surfaced as
 * {@link DeploymentRegistryError} with `retryable: true` so callers can
 * implement retry/recovery.
 */
export class DeploymentRegistry {
  private readonly store: DeploymentStore;
  private readonly authorizer: DeploymentAuthorizer;

  constructor(options: DeploymentRegistryOptions = {}) {
    this.store = options.store ?? new InMemoryDeploymentStore();
    this.authorizer = options.authorizer ?? (() => true);
  }

  /**
   * Record a new deployment. Rejects invalid records and unauthorized writes.
   * If a record already exists for the same (environment, network, address),
   * it is replaced only when the new state is a valid transition from the
   * existing state.
   */
  async recordDeployment(input: DeploymentRecordInput): Promise<DeploymentRecord> {
    validateInput(input);

    const state: DeploymentLifecycleState = input.state ?? 'pending';
    const key = recordKey(input.environment, input.network, input.address);

    await this.assertAuthorized({
      type: 'record',
      environment: input.environment,
      network: input.network,
      address: input.address,
    });

    let existing: DeploymentRecord | undefined;
    try {
      existing = await this.store.get(key);
    } catch (err) {
      throw new DeploymentRegistryError(
        'storage_failure',
        `failed to read existing deployment record: ${errorMessage(err)}`,
        { retryable: true, cause: err },
      );
    }

    if (existing) {
      validateStoredRecord(existing);
      if (existing.state !== state) {
        assertTransition(existing.state, state);
      }
    }

    const now = new Date().toISOString();
    const record: DeploymentRecord = {
      environment: input.environment,
      network: input.network,
      address: input.address,
      ledger: input.ledger,
      specVersion: input.specVersion,
      state,
      metadata: input.metadata,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    try {
      await this.store.put(key, record);
    } catch (err) {
      throw new DeploymentRegistryError(
        'storage_failure',
        `failed to persist deployment record: ${errorMessage(err)}`,
        { retryable: true, cause: err },
      );
    }

    return record;
  }

  /**
   * Retrieve a deployment record. Throws `not_found` if absent and
   * `invalid_record` if the stored data fails validation.
   */
  async getDeployment(
    environment: string,
    network: string,
    address: string,
  ): Promise<DeploymentRecord> {
    const key = recordKey(environment, network, address);
    let record: DeploymentRecord | undefined;
    try {
      record = await this.store.get(key);
    } catch (err) {
      throw new DeploymentRegistryError(
        'storage_failure',
        `failed to read deployment record: ${errorMessage(err)}`,
        { retryable: true, cause: err },
      );
    }
    if (!record) {
      throw new DeploymentRegistryError(
        'not_found',
        `no deployment record for ${key}`,
      );
    }
    validateStoredRecord(record);
    return record;
  }

  /**
   * List all deployment records for an environment.
   */
  async listByEnvironment(environment: string): Promise<DeploymentRecord[]> {
    if (!isNonEmptyString(environment)) {
      throw new DeploymentRegistryError(
        'invalid_record',
        'environment must be a non-empty string',
      );
    }
    let records: DeploymentRecord[];
    try {
      records = await this.store.listByEnvironment(environment);
    } catch (err) {
      throw new DeploymentRegistryError(
        'storage_failure',
        `failed to list deployment records: ${errorMessage(err)}`,
        { retryable: true, cause: err },
      );
    }
    for (const record of records) {
      validateStoredRecord(record);
    }
    return records;
  }

  /**
   * Transition a deployment record to a new lifecycle state.
   * Rejects invalid transitions and unauthorized writes.
   */
  async transitionState(
    environment: string,
    network: string,
    address: string,
    nextState: DeploymentLifecycleState,
  ): Promise<DeploymentRecord> {
    if (!LIFECYCLE_STATES.has(nextState)) {
      throw new DeploymentRegistryError(
        'invalid_transition',
        `unknown lifecycle state ${String(nextState)}`,
      );
    }

    await this.assertAuthorized({
      type: 'transition',
      environment,
      network,
      address,
    });

    const key = recordKey(environment, network, address);
    let existing: DeploymentRecord | undefined;
    try {
      existing = await this.store.get(key);
    } catch (err) {
      throw new DeploymentRegistryError(
        'storage_failure',
        `failed to read deployment record: ${errorMessage(err)}`,
        { retryable: true, cause: err },
      );
    }
    if (!existing) {
      throw new DeploymentRegistryError(
        'not_found',
        `no deployment record for ${key}`,
      );
    }
    validateStoredRecord(existing);
    assertTransition(existing.state, nextState);

    const updated: DeploymentRecord = {
      ...existing,
      state: nextState,
      updatedAt: new Date().toISOString(),
    };

    try {
      await this.store.put(key, updated);
    } catch (err) {
      throw new DeploymentRegistryError(
        'storage_failure',
        `failed to persist state transition: ${errorMessage(err)}`,
        { retryable: true, cause: err },
      );
    }

    return updated;
  }

  private async assertAuthorized(action: {
    type: 'record' | 'transition';
    environment: string;
    network: string;
    address: string;
  }): Promise<void> {
    let allowed: boolean;
    try {
      allowed = await this.authorizer(action);
    } catch (err) {
      throw new DeploymentRegistryError(
        'unauthorized',
        `authorization check failed: ${errorMessage(err)}`,
        { cause: err },
      );
    }
    if (!allowed) {
      throw new DeploymentRegistryError(
        'unauthorized',
        `not authorized to ${action.type} deployment for ${action.environment}:${action.network}:${action.address}`,
      );
    }
  }
}

function assertTransition(
  from: DeploymentLifecycleState,
  to: DeploymentLifecycleState,
): void {
  if (from === to) {
    return;
  }
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new DeploymentRegistryError(
      'invalid_transition',
      `cannot transition from ${from} to ${to}`,
    );
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}