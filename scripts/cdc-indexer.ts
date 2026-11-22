#!/usr/bin/env tsx
/**
 * Soroban Stream Event CDC Indexer — issue #531
 *
 * Background service that listens for Soroban contract events emitted by
 * the Fundable payment-stream contract and indexes stream history into
 * PostgreSQL for efficient off-chain querying.
 *
 * # Architecture
 *
 * This is a Change Data Capture (CDC) pattern:
 *   1. Poll the Stellar Soroban RPC `getEvents` endpoint on each tick.
 *   2. Parse raw XDR event data into typed `StreamEvent` records.
 *   3. Write new events to `stream_events` table via an UPSERT
 *      (idempotent on `event_id`).
 *   4. Persist the latest processed ledger sequence in `cdc_cursors`
 *      so restarts resume from the correct position without gaps or
 *      duplicate processing.
 *
 * # Partitioning (issue #217)
 *
 * Ingestion is partitioned by `(network, deploymentId)`. Each partition has
 * its own cursor, backfill job state, and health record, and runs in its own
 * independent loop. A stalled or failing partition therefore cannot block
 * ingestion for any other deployment: errors are isolated per partition and
 * surfaced explicitly as `healthy` / `degraded` / `stalled` states.
 *
 * Partition identity is `"<network>:<deploymentId>"`. The legacy single
 * `INDEXER_ID` cursor is migrated into the partition for the configured
 * network + deployment on first start (see `migrateLegacyCursor`).
 *
 * # Table schemas
 *
 * ```sql
 * CREATE TABLE IF NOT EXISTS stream_events (
 *   id              BIGSERIAL PRIMARY KEY,
 *   event_id        TEXT        NOT NULL UNIQUE,   -- <ledger>-<tx_index>-<event_index>
 *   contract_id     TEXT        NOT NULL,
 *   event_type      TEXT        NOT NULL,          -- stream_created|updated|cancelled|completed
 *   ledger_sequence BIGINT      NOT NULL,
 *   ledger_timestamp TIMESTAMPTZ NOT NULL,
 *   tx_hash         TEXT        NOT NULL,
 *   sender          TEXT,
 *   recipient       TEXT,
 *   asset           TEXT,
 *   amount          NUMERIC,
 *   stream_id       TEXT,
 *   raw_xdr         TEXT        NOT NULL,
 *   indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
 * );
 *
 * CREATE TABLE IF NOT EXISTS cdc_cursors (
 *   indexer_id      TEXT        PRIMARY KEY,       -- "<network>:<deploymentId>"
 *   last_ledger     BIGINT      NOT NULL,
 *   updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
 * );
 *
 * CREATE TABLE IF NOT EXISTS cdc_backfill_jobs (
 *   partition_id    TEXT        NOT NULL,
 *   job_id          TEXT        NOT NULL,
 *   from_ledger     BIGINT      NOT NULL,
 *   to_ledger       BIGINT      NOT NULL,
 *   next_ledger     BIGINT      NOT NULL,
 *   status          TEXT        NOT NULL,          -- pending|running|completed|failed
 *   attempts        INTEGER     NOT NULL DEFAULT 0,
 *   last_error      TEXT,
 *   updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *   PRIMARY KEY (partition_id, job_id)
 * );
 *
 * CREATE TABLE IF NOT EXISTS cdc_partition_health (
 *   partition_id    TEXT        PRIMARY KEY,
 *   network         TEXT        NOT NULL,
 *   deployment_id   TEXT        NOT NULL,
 *   state           TEXT        NOT NULL,          -- healthy|degraded|stalled
 *   last_success_at TIMESTAMPTZ,
 *   last_error      TEXT,
 *   consecutive_failures INTEGER NOT NULL DEFAULT 0,
 *   updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
 * );
 * ```
 *
 * # Environment variables
 *
 * | Variable              | Required | Default                                  | Description |
 * |-----------------------|----------|------------------------------------------|-------------|
 * | DATABASE_URL          | ✓        | —                                        | PostgreSQL connection string |
 * | CONTRACT_IDS          | ✓        | —                                        | Comma-separated Soroban contract IDs |
 * | STELLAR_RPC_URL       | ✗        | https://soroban-testnet.stellar.org      | Soroban RPC endpoint |
 * | NETWORK_PASSPHRASE    | ✗        | Test SDF Network ; September 2015        | Stellar network passphrase |
 * | NETWORK               | ✗        | derived from passphrase                  | Network label used for partitioning |
 * | DEPLOYMENT_ID         | ✗        | default                                  | Deployment identifier used for partitioning |
 * | POLL_INTERVAL_SECONDS | ✗        | 5                                        | Seconds between event polls |
 * | LEDGER_LOOKBACK       | ✗        | 1000                                     | Ledgers to look back on first start |
 * | MAX_EVENTS_PER_POLL   | ✗        | 200                                      | Max events fetched per poll cycle |
 * | INDEXER_ID            | ✗        | fundable_stream_indexer                  | Legacy cursor ID (migrated into partition) |
 * | DRY_RUN               | ✗        | false                                    | Parse events but skip DB writes |
 * | STALL_THRESHOLD_SECONDS | ✗      | 120                                      | Age of last success before a partition is `stalled` |
 *
 * # Running
 *
 *   pnpm tsx scripts/cdc-indexer.ts
 */

import { Pool, type PoolClient } from "pg";
import {
  Networks,
  xdr,
  scValToNative,
  type SorobanEvent,
} from "@stellar/stellar-sdk";
import { Server as RpcServer } from "@stellar/stellar-sdk/rpc";
import { WebhookService } from "../apps/web/src/services/webhook.service";
import path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export type StreamEventType =
  | "stream_created"
  | "stream_updated"
  | "stream_cancelled"
  | "stream_completed"
  | "stream_withdrawn"
  | "unknown";

export interface StreamEvent {
  /** Unique event identifier: <ledger>-<txIndex>-<eventIndex> */
  eventId: string;
  contractId: string;
  eventType: StreamEventType;
  ledgerSequence: number;
  /** ISO 8601 timestamp */
  ledgerTimestamp: string;
  txHash: string;
  sender: string | null;
  recipient: string | null;
  /** Token contract address */
  asset: string | null;
  /** Amount in stroops as a string (avoids JS precision loss) */
  amount: string | null;
  /** On-chain stream identifier */
  streamId: string | null;
  /** Raw XDR of the event value */
  rawXdr: string;
}

export interface CdcCursor {
  indexerId: string;
  lastLedger: number;
  updatedAt: string;
}

/**
 * A partition of the indexer: one network + one deployment. Each partition
 * owns its cursor, backfill jobs, and health record.
 */
export interface Partition {
  /** Stable partition key: "<network>:<deploymentId>" */
  id: string;
  network: string;
  deploymentId: string;
  contractIds: string[];
  rpcUrl: string;
  networkPassphrase: string;
}

export type PartitionState = "healthy" | "degraded" | "stalled";

export interface PartitionHealth {
  partitionId: string;
  network: string;
  deploymentId: string;
  state: PartitionState;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  updatedAt: string;
}

export type BackfillStatus = "pending" | "running" | "completed" | "failed";

export interface BackfillJob {
  partitionId: string;
  jobId: string;
  fromLedger: number;
  toLedger: number;
  nextLedger: number;
  status: BackfillStatus;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
}

export interface IndexerConfig {
  databaseUrl: string;
  contractIds: string[];
  rpcUrl: string;
  networkPassphrase: string;
  network: string;
  deploymentId: string;
  pollIntervalSeconds: number;
  ledgerLookback: number;
  maxEventsPerPoll: number;
  indexerId: string;
  dryRun: boolean;
  stallThresholdSeconds: number;
}

export type LogLevel = "info" | "warn" | "error" | "debug";

/** Pluggable DB interface for testing. */
export interface DbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class IndexerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "CONFIG_ERROR"
      | "DB_ERROR"
      | "RPC_ERROR"
      | "PARSE_ERROR"
      | "UNKNOWN_DEPLOYMENT"
      | "UNAUTHORIZED"
  ) {
    super(message);
    this.name = "IndexerError";
    Object.setPrototypeOf(this, IndexerError.prototype);
  }
}

// ── Logging ───────────────────────────────────────────────────────────────────

export function log(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: "cdc-indexer",
    message,
    ...context,
  };
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(JSON.stringify(entry) + "\n");
}

// ── Partition helpers ─────────────────────────────────────────────────────────

/** Build the stable partition key for a network + deployment pair. */
export function partitionId(network: string, deploymentId: string): string {
  return `${network}:${deploymentId}`;
}

/** Derive a human-readable network label from a passphrase. */
export function deriveNetworkLabel(passphrase: string): string {
  if (passphrase === Networks.PUBLIC) return "public";
  if (passphrase === Networks.TESTNET) return "testnet";
  if (passphrase === Networks.FUTURENET) return "futurenet";
  if (passphrase === Networks.SANDBOX) return "sandbox";
  return "custom";
}

// ── Config ────────────────────────────────────────────────────────────────────

export function loadConfig(): IndexerConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new IndexerError("DATABASE_URL environment variable is required", "CONFIG_ERROR");
  }

  const contractIdsRaw = process.env.CONTRACT_IDS;
  if (!contractIdsRaw) {
    throw new IndexerError(
      "CONTRACT_IDS environment variable is required (comma-separated Soroban contract IDs)",
      "CONFIG_ERROR"
    );
  }

  const contractIds = contractIdsRaw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (contractIds.length === 0) {
    throw new IndexerError("CONTRACT_IDS must contain at least one contract ID", "CONFIG_ERROR");
  }

  for (const id of contractIds) {
    if (!/^C[A-Z2-7]{55}$/.test(id)) {
      throw new IndexerError(
        `Invalid contract ID format: ${id} (must be a C… Stellar address)`,
        "CONFIG_ERROR"
      );
    }
  }

  const networkPassphrase = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;
  const network = process.env.NETWORK ?? deriveNetworkLabel(networkPassphrase);
  const deploymentId = process.env.DEPLOYMENT_ID ?? "default";

  if (!network.trim()) {
    throw new IndexerError("NETWORK must not be empty", "CONFIG_ERROR");
  }
  if (!deploymentId.trim()) {
    throw new IndexerError("DEPLOYMENT_ID must not be empty", "CONFIG_ERROR");
  }

  return {
    databaseUrl,
    contractIds,
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    networkPassphrase,
    network,
    deploymentId,
    pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS ?? 5),
    ledgerLookback: Number(process.env.LEDGER_LOOKBACK ?? 1_000),
    maxEventsPerPoll: Number(process.env.MAX_EVENTS_PER_POLL ?? 200),
    indexerId: process.env.INDEXER_ID ?? "fundable_stream_indexer",
    dryRun: process.env.DRY_RUN === "true",
    stallThresholdSeconds: Number(process.env.STALL_THRESHOLD_SECONDS ?? 120),
  };
}

/** Build the partition descriptor for the configured network + deployment. */
export function buildPartition(config: IndexerConfig): Partition {
  return {
    id: partitionId(config.network, config.deploymentId),
    network: config.network,
    deploymentId: config.deploymentId,
    contractIds: config.contractIds,
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
  };
}

// ── Database helpers ──────────────────────────────────────────────────────────

/**
 * Ensure the required tables exist. Idempotent — safe to call on every startup.
 */
export async function ensureSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS stream_events (
      id               BIGSERIAL    PRIMARY KEY,
      event_id         TEXT         NOT NULL UNIQUE,
      contract_id      TEXT         NOT NULL,
      event_type       TEXT         NOT NULL,
      ledger_sequence  BIGINT       NOT NULL,
      ledger_timestamp TIMESTAMPTZ  NOT NULL,
      tx_hash          TEXT         NOT NULL,
      sender           TEXT,
      recipient        TEXT,
      asset            TEXT,
      amount           NUMERIC,
      stream_id        TEXT,
      raw_xdr          TEXT         NOT NULL,
      indexed_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_stream_events_contract
      ON stream_events (contract_id)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_stream_events_ledger
      ON stream_events (ledger_sequence)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_stream_events_sender
      ON stream_events (sender) WHERE sender IS NOT NULL
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_stream_events_recipient
      ON stream_events (recipient) WHERE recipient IS NOT NULL
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cdc_cursors (
      indexer_id  TEXT        PRIMARY KEY,
      last_ledger BIGINT      NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cdc_backfill_jobs (
      partition_id TEXT        NOT NULL,
      job_id       TEXT        NOT NULL,
      from_ledger  BIGINT      NOT NULL,
      to_ledger    BIGINT      NOT NULL,
      next_ledger  BIGINT      NOT NULL,
      status       TEXT        NOT NULL,
      attempts     INTEGER     NOT NULL DEFAULT 0,
      last_error   TEXT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (partition_id, job_id)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_cdc_backfill_jobs_partition
      ON cdc_backfill_jobs (partition_id, status)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cdc_partition_health (
      partition_id         TEXT        PRIMARY KEY,
      network              TEXT        NOT NULL,
      deployment_id        TEXT        NOT NULL,
      state                TEXT        NOT NULL,
      last_success_at      TIMESTAMPTZ,
      last_error           TEXT,
      consecutive_failures INTEGER     NOT NULL DEFAULT 0,
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Read the last processed ledger for a partition.
 * Returns `null` if no cursor exists (first run).
 */
export async function getCursor(
  db: DbClient,
  indexerId: string
): Promise<number | null> {
  const result = await db.query<{ last_ledger: string }>(
    "SELECT last_ledger FROM cdc_cursors WHERE indexer_id = $1",
    [indexerId]
  );
  if (result.rows.length === 0) return null;
  return Number(result.rows[0].last_ledger);
}

/**
 * Persist the latest processed ledger sequence for a partition.
 */
export async function setCursor(
  db: DbClient,
  indexerId: string,
  lastLedger: number
): Promise<void> {
  await db.query(
    `INSERT INTO cdc_cursors (indexer_id, last_ledger, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (indexer_id)
     DO UPDATE SET last_ledger = EXCLUDED.last_ledger, updated_at = NOW()`,
    [indexerId, lastLedger]
  );
}

/**
 * Migrate a legacy single-indexer cursor into the partition cursor.
 *
 * Older deployments stored a cursor under `INDEXER_ID` (e.g.
 * `fundable_stream_indexer`). On first start of a partitioned deployment we
 * copy that value into the partition cursor if — and only if — the partition
 * cursor does not yet exist. This preserves resume position across the
 * upgrade without duplicating or skipping ledgers.
 *
 * Returns `true` if a migration occurred.
 */
export async function migrateLegacyCursor(
  db: DbClient,
  legacyIndexerId: string,
  partition: Partition
): Promise<boolean> {
  if (legacyIndexerId === partition.id) return false;

  const existing = await getCursor(db, partition.id);
  if (existing !== null) return false;

  const legacy = await getCursor(db, legacyIndexerId);
  if (legacy === null) return false;

  await setCursor(db, partition.id, legacy);
  log("info", "Migrated legacy cursor into partition", {
    partitionId: partition.id,
    legacyIndexerId,
    lastLedger: legacy,
  });
  return true;
}

/**
 * Upsert a batch of stream events. Idempotent on `event_id`.
 */
export async function insertEvents(
  db: DbClient,
  events: StreamEvent[]
): Promise<number> {
  if (events.length === 0) return 0;

  let inserted = 0;
  for (const ev of events) {
    const result = await db.query(
      `INSERT INTO stream_events (
         event_id, contract_id, event_type, ledger_sequence, ledger_timestamp,
         tx_hash, sender, recipient, asset, amount, stream_id, raw_xdr
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        ev.eventId,
        ev.contractId,
        ev.eventType,
        ev.ledgerSequence,
        ev.ledgerTimestamp,
        ev.txHash,
        ev.sender,
        ev.recipient,
        ev.asset,
        ev.amount,
        ev.streamId,
        ev.rawXdr,
      ]
    );
    // pg returns rowCount for INSERT
    if ((result as unknown as { rowCount: number }).rowCount > 0) inserted++;
  }
  return inserted;
}

// ── Partition health ──────────────────────────────────────────────────────────

/**
 * Compute the explicit health state for a partition from its persisted
 * record. A partition with no recorded success and no failures is `healthy`
 * (it has simply not run yet). A partition whose last success is older than
 * the stall threshold is `stalled` regardless of failure count.
 */
export function computePartitionState(
  health: Pick<PartitionHealth, "lastSuccessAt" | "consecutiveFailures">,
  stallThresholdSeconds: number,
  now: number = Date.now()
): PartitionState {
  if (health.lastSuccessAt) {
    const ageSeconds = (now - new Date(health.lastSuccessAt).getTime()) / 1_000;
    if (ageSeconds > stallThresholdSeconds) return "stalled";
  }
  if (health.consecutiveFailures > 0) return "degraded";
  return "healthy";
}

/** Read the persisted health record for a partition, if any. */
export async function getPartitionHealth(
  db: DbClient,
  partitionIdValue: string
): Promise<PartitionHealth | null> {
  const result = await db.query<{
    partition_id: string;
    network: string;
    deployment_id: string;
    state: PartitionState;
    last_success_at: string | null;
    last_error: string | null;
    consecutive_failures: number;
    updated_at: string;
  }>(
    `SELECT partition_id, network, deployment_id, state, last_success_at,
            last_error, consecutive_failures, updated_at
       FROM cdc_partition_health
      WHERE partition_id = $1`,
    [partitionIdValue]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    partitionId: row.partition_id,
    network: row.network,
    deploymentId: row.deployment_id,
    state: row.state,
    lastSuccessAt: row.last_success_at
      ? new Date(row.last_success_at).toISOString()
      : null,
    lastError: row.last_error,
    consecutiveFailures: Number(row.consecutive_failures),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Record a successful poll cycle for a partition. Resets the failure counter
 * and marks the partition `healthy`.
 */
export async function recordPartitionSuccess(
  db: DbClient,
  partition: Partition
): Promise<void> {
  await db.query(
    `INSERT INTO cdc_partition_health (
       partition_id, network, deployment_id, state, last_success_at,
       last_error, consecutive_failures, updated_at
     ) VALUES ($1, $2, $3, 'healthy', NOW(), NULL, 0, NOW())
     ON CONFLICT (partition_id) DO UPDATE SET
       state = 'healthy',
       last_success_at = NOW(),
       last_error = NULL,
       consecutive_failures = 0,
       updated_at = NOW()`,
    [partition.id, partition.network, partition.deploymentId]
  );
}

/**
 * Record a failed poll cycle for a partition. Increments the failure counter,
 * stores the error, and derives the explicit state (`degraded` or `stalled`).
 * Returns the resulting state so callers can surface it.
 */
export async function recordPartitionFailure(
  db: DbClient,
  partition: Partition,
  error: string,
  stallThresholdSeconds: number
): Promise<PartitionState> {
  const existing = await getPartitionHealth(db, partition.id);
  const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
  const lastSuccessAt = existing?.lastSuccessAt ?? null;
  const state = computePartitionState(
    { lastSuccessAt, consecutiveFailures },
    stallThresholdSeconds
  );

  await db.query(
    `INSERT INTO cdc_partition_health (
       partition_id, network, deployment_id, state, last_success_at,
       last_error, consecutive_failures, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (partition_id) DO UPDATE SET
       state = EXCLUDED.state,
       last_error = EXCLUDED.last_error,
       consecutive_failures = EXCLUDED.consecutive_failures,
       updated_at = NOW()`,
    [
      partition.id,
      partition.network,
      partition.deploymentId,
      state,
      lastSuccessAt,
      error,
      consecutiveFailures,
    ]
  );

  return state;
}

// ── Backfill jobs ─────────────────────────────────────────────────────────────

/** Enqueue a backfill job scoped to a partition. */
export async function enqueueBackfill(
  db: DbClient,
  partition: Partition,
  jobId: string,
  fromLedger: number,
  toLedger: number
): Promise<void> {
  if (fromLedger > toLedger) {
    throw new IndexerError(
      `Invalid backfill range: fromLedger ${fromLedger} > toLedger ${toLedger}`,
      "CONFIG_ERROR"
    );
  }
  await db.query(
    `INSERT INTO cdc_backfill_jobs (
       partition_id, job_id, from_ledger, to_ledger, next_ledger, status,
       attempts, last_error, updated_at
     ) VALUES ($1, $2, $3, $4, $3, 'pending', 0, NULL, NOW())
     ON CONFLICT (partition_id, job_id) DO NOTHING`,
    [partition.id, jobId, fromLedger, toLedger]
  );
}

/** List backfill jobs for a partition (optionally filtered by status). */
export async function listBackfills(
  db: DbClient,
  partitionIdValue: string,
  status?: BackfillStatus
): Promise<BackfillJob[]> {
  const params: unknown[] = [partitionIdValue];
  let sql = `SELECT partition_id, job_id, from_ledger, to_ledger, next_ledger,
                    status, attempts, last_error, updated_at
               FROM cdc_backfill_jobs
              WHERE partition_id = $1`;
  if (status) {
    params.push(status);
    sql += ` AND status = $2`;
  }
  sql += ` ORDER BY job_id`;

  const result = await db.query<{
    partition_id: string;
    job_id: string;
    from_ledger: string;
    to_ledger: string;
    next_ledger: string;
    status: BackfillStatus;
    attempts: number;
    last_error: string | null;
    updated_at: string;
  }>(sql, params);

  return result.rows.map((row) => ({
    partitionId: row.partition_id,
    jobId: row.job_id,
    fromLedger: Number(row.from_ledger),
    toLedger: Number(row.to_ledger),
    nextLedger: Number(row.next_ledger),
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

/**
 * Advance a backfill job's progress. Marks the job `completed` when the
 * cursor reaches `to_ledger`.
 */
export async function advanceBackfill(
  db: DbClient,
  partitionIdValue: string,
  jobId: string,
  nextLedger: number
): Promise<void> {
  await db.query(
    `UPDATE cdc_backfill_jobs
        SET next_ledger = $3,
            status = CASE WHEN $3 > to_ledger THEN 'completed' ELSE 'running' END,
            updated_at = NOW()
      WHERE partition_id = $1 AND job_id = $2`,
    [partitionIdValue, jobId, nextLedger]
  );
}

/**
 * Record a failed backfill attempt. Increments `attempts` and stores the
 * error. The job remains retryable (`failed`) unless it has exhausted its
 * attempts budget, in which case it stays `failed` for operator inspection.
 */
export async function failBackfill(
  db: DbClient,
  partitionIdValue: string,
  jobId: string,
  error: string
): Promise<void> {
  await db.query(
    `UPDATE cdc_backfill_jobs
        SET status = 'failed',
            attempts = attempts + 1,
            last_error = $3,
            updated_at = NOW()
      WHERE partition_id = $1 AND job_id = $2`,
    [partitionIdValue, jobId, error]
  );
}

/**
 * Reset a failed backfill job so it can be retried. Only jobs belonging to
 * the given partition are affected — a partition cannot retry another
 * partition's jobs.
 */
export async function retryBackfill(
  db: DbClient,
  partitionIdValue: string,
  jobId: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE cdc_backfill_jobs
        SET status = 'pending',
            last_error = NULL,
            updated_at = NOW()
      WHERE partition_id = $1 AND job_id = $2 AND status = 'failed'`,
    [partitionIdValue, jobId]
  );
  return (result as unknown as { rowCount: number }).rowCount > 0;
}

// ── Operator authorization ────────────────────────────────────────────────────

/**
 * Authorize an operator action against a partition.
 *
 * Operators may only act on partitions they are explicitly scoped to. An
 * operator with no scope (empty list) is treated as unauthorized for every
 * partition — least privilege by default. Unknown deployments are rejected
 * with `UNKNOWN_DEPLOYMENT` so callers can distinguish a typo from a
 * permission problem.
 */
export function authorizeOperator(
  operator: { id: string; allowedPartitions: string[] },
  partition: Partition | null
): void {
  if (!partition) {
    throw new IndexerError(
      "Unknown deployment: partition does not exist",
      "UNKNOWN_DEPLOYMENT"
    );
  }
  if (!operator.allowedPartitions.includes(partition.id)) {
    throw new IndexerError(
      `Operator ${operator.id} is not authorized for partition ${partition.id}`,
      "UNAUTHORIZED"
    );
  }
}

// ── Event parsing ─────────────────────────────────────────────────────────────

/** Map raw event topic strings to typed StreamEventType. */
export function parseEventType(topics: string[]): StreamEventType {
  const topicStr = topics.join(",").toLowerCase();
  if (topicStr.includes("create") || topicStr.includes("stream_created")) return "stream_created";
  if (topicStr.includes("update") || topicStr.includes("stream_updated")) return "stream_updated";
  if (topicStr.includes("cancel") || topicStr.includes("stream_cancelled")) return "stream_cancelled";
  if (topicStr.includes("complete") || topicStr.includes("stream_completed")) return "stream_completed";
  if (topicStr.includes("withdraw") || topicStr.includes("stream_withdrawn")) return "stream_withdrawn";
  return "unknown";
}

/**
 * Parse a raw Soroban event into a typed `StreamEvent`.
 *
 * The Fundable stream contract emits events with the following structure:
 *   topics[0]: event name symbol ("stream_created", "stream_updated", etc.)
 *   topics[1]: sender address
 *   topics[2]: recipient address
 *   value:     map { stream_id, asset, amount }
 *
 * This parser is defensive — missing fields are set to null rather than
 * throwing, so a malformed event does not halt the indexer.
 */
export function parseStreamEvent(
  rawEvent: SorobanEvent,
  ledgerSequence: number,
  ledgerTimestamp: number
): StreamEvent {
  const eventId = `${ledgerSequence}-${rawEvent.id ?? "0"}`;
  const contractId = rawEvent.contractId ?? "";
  const txHash = rawEvent.txHash ?? "";
  const rawXdr = rawEvent.value?.xdr ?? "";

  // Parse topics
  const topicStrings: string[] = [];
  let sender: string | null = null;
  let recipient: string | null = null;

  try {
    const topics = rawEvent.topic ?? [];
    for (let i = 0; i < topics.length; i++) {
      try {
        const decoded = scValToNative(xdr.ScVal.fromXDR(topics[i] as unknown as string, "base64"));
        const str = String(decoded);
        topicStrings.push(str);
        if (i === 1 && str.startsWith("G")) sender = str;
        if (i === 2 && str.startsWith("G")) recipient = str;
      } catch {
        topicStrings.push("");
      }
    }
  } catch {
    // Topic parsing failed — continue with empty topics
  }

  // Parse value (map containing stream details)
  let asset: string | null = null;
  let amount: string | null = null;
  let streamId: string | null = null;

  try {
    if (rawXdr) {
      const val = scValToNative(xdr.ScVal.fromXDR(rawXdr, "base64"));
      if (val && typeof val === "object") {
        const map = val as Record<string, unknown>;
        if (map.asset) asset = String(map.asset);
        if (map.amount != null) amount = String(map.amount);
        if (map.stream_id) streamId = String(map.stream_id);
        if (map.id) streamId = String(map.id);
      }
    }
  } catch {
    // Value parsing failed — leave fields null
  }

  const eventType = parseEventType(topicStrings);

  return {
    eventId,
    contractId,
    eventType,
    ledgerSequence,
    ledgerTimestamp: new Date(ledgerTimestamp * 1_000).toISOString(),
    txHash,
    sender,
    recipient,
    asset,
    amount,
    streamId,
    rawXdr,
  };
}

// ── RPC polling ───────────────────────────────────────────────────────────────

/**
 * Fetch events from the Soroban RPC for all watched contracts since
 * `startLedger`.
 */
export async function fetchEvents(
  rpc: RpcServer,
  contractIds: string[],
  startLedger: number,
  limit: number
): Promise<SorobanEvent[]> {
  try {
    const response = await rpc.getEvents({
      startLedger,
      filters: contractIds.map((id) => ({
        type: "contract" as const,
        contractIds: [id],
      })),
      limit,
    });
    return response.events ?? [];
  } catch (err) {
    throw new IndexerError(
      `RPC getEvents failed: ${(err as Error).message}`,
      "RPC_ERROR"
    );
  }
}

/**
 * Fetch the current ledger sequence from the RPC.
 */
export async function getCurrentLedger(rpc: RpcServer): Promise<number> {
  try {
    const latest = await rpc.getLatestLedger();
    return latest.sequence;
  } catch (err) {
    throw new IndexerError(
      `Failed to fetch latest ledger: ${(err as Error).message}`,
      "RPC_ERROR"
    );
  }
}

// ── Main poll cycle ───────────────────────────────────────────────────────────

/**
 * Run one full poll cycle for a single partition:
 *   1. Read the partition cursor from DB.
 *   2. Fetch events since cursor (or lookback) from RPC.
 *   3. Parse and upsert into stream_events.
 *   4. Advance the partition cursor to latest ledger.
 *   5. Record partition health (success or failure).
 *
 * Errors are isolated to this partition: they are recorded against the
 * partition's health row and never thrown to the caller, so a stalled
 * partition cannot block other partitions' loops.
 *
 * Returns the number of new events indexed.
 */
export async function runPollCycle(
  db: DbClient,
  rpc: RpcServer,
  config: IndexerConfig,
  partition: Partition = buildPartition(config)
): Promise<number> {
  try {
    return await runPollCycleInner(db, rpc, config, partition);
  } catch (err) {
    const message = (err as Error).message;
    log("error", "Poll cycle failed for partition — isolating", {
      partitionId: partition.id,
      error: message,
    });
    try {
      const state = await recordPartitionFailure(
        db,
        partition,
        message,
        config.stallThresholdSeconds
      );
      log("warn", "Partition marked unhealthy", {
        partitionId: partition.id,
        state,
      });
    } catch (healthErr) {
      log("error", "Failed to record partition failure", {
        partitionId: partition.id,
        error: (healthErr as Error).message,
      });
    }
    return 0;
  }
}

async function runPollCycleInner(
  db: DbClient,
  rpc: RpcServer,
  config: IndexerConfig,
  partition: Partition
): Promise<number> {
  // Step 1: determine start ledger
  const cursor = await getCursor(db, partition.id);
  let currentLedger: number;
