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
 * # Replay across event-schema versions (issue #220)
 *
 * When the projection schema changes, the indexer can rebuild state
 * deterministically from retained raw events (`stream_events.raw_xdr`) and
 * compare the replayed projections against the current outputs before
 * cutover. The replay engine:
 *
 *   1. Reads retained raw events ordered by `(ledger_sequence, event_id)`.
 *   2. Replays them through the projection for a *target* schema version.
 *   3. Compares the replayed projection against the currently persisted one.
 *   4. Blocks cutover on any mismatch, surfacing an explicit failure state.
 *
 * Replay runs are tracked in `cdc_replay_runs` so operators can inspect
 * status (`pending|running|verified|mismatch|failed`), progress, and the
 * first divergence. Partial replays are resumable: the last successfully
 * replayed event id is persisted and a retry continues from there.
 *
 * # Bounded queues and concurrency (issue #222)
 *
 * Event consumers use a bounded queue with backpressure. When the queue is
 * full, producers await capacity instead of buffering unboundedly. This
 * bounds memory under RPC or consumer outages and lets the indexer recover
 * with a predictable throughput once the downstream recovers.
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
 *   indexer_id      TEXT        PRIMARY KEY,
 *   last_ledger     BIGINT      NOT NULL,
 *   updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
 * );
 *
 * CREATE TABLE IF NOT EXISTS cdc_replay_runs (
 *   run_id          TEXT        PRIMARY KEY,
 *   indexer_id      TEXT        NOT NULL,
 *   target_version  INTEGER     NOT NULL,
 *   status          TEXT        NOT NULL,          -- pending|running|verified|mismatch|failed
 *   last_event_id   TEXT,
 *   replayed_count  BIGINT      NOT NULL DEFAULT 0,
 *   mismatch_count  BIGINT      NOT NULL DEFAULT 0,
 *   first_mismatch  JSONB,
 *   error           TEXT,
 *   started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
 * | POLL_INTERVAL_SECONDS | ✗        | 5                                        | Seconds between event polls |
 * | LEDGER_LOOKBACK       | ✗        | 1000                                     | Ledgers to look back on first start |
 * | MAX_EVENTS_PER_POLL   | ✗        | 200                                      | Max events fetched per poll cycle |
 * | INDEXER_ID            | ✗        | fundable_stream_indexer                  | Unique ID for the cursor row |
 * | DRY_RUN               | ✗        | false                                    | Parse events but skip DB writes |
 * | CONSUMER_QUEUE_SIZE   | ✗        | 1000                                     | Bounded queue capacity for consumers |
 * | CONSUMER_CONCURRENCY  | ✗        | 4                                        | Max in-flight consumer tasks |
 * | REPLAY_BATCH_SIZE     | ✗        | 500                                      | Events replayed per batch |
 * | REPLAY_TARGET_VERSION | ✗        | —                                        | Target schema version for replay |
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

export interface IndexerConfig {
  databaseUrl: string;
  contractIds: string[];
  rpcUrl: string;
  networkPassphrase: string;
  pollIntervalSeconds: number;
  ledgerLookback: number;
  maxEventsPerPoll: number;
  indexerId: string;
  dryRun: boolean;
  /** Bounded queue capacity for event consumers (issue #222). */
  consumerQueueSize: number;
  /** Max in-flight consumer tasks (issue #222). */
  consumerConcurrency: number;
  /** Events replayed per batch during schema replay (issue #220). */
  replayBatchSize: number;
  /** Target schema version for replay (issue #220). */
  replayTargetVersion: number | null;
}

export type LogLevel = "info" | "warn" | "error" | "debug";

/** Pluggable DB interface for testing. */
export interface DbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

// ── Replay types (issue #220) ─────────────────────────────────────────────────

export type ReplayStatus =
  | "pending"
  | "running"
  | "verified"
  | "mismatch"
  | "failed";

export interface ReplayMismatch {
  eventId: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface ReplayRun {
  runId: string;
  indexerId: string;
  targetVersion: number;
  status: ReplayStatus;
  lastEventId: string | null;
  replayedCount: number;
  mismatchCount: number;
  firstMismatch: ReplayMismatch | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
}

/**
 * A projection maps a raw retained event to a deterministic output record.
 * Different schema versions provide different projections; replay compares
 * the target projection's output against the currently persisted output.
 */
export interface Projection {
  schemaVersion: number;
  /** Deterministically project a single event into a comparable record. */
  project(event: StreamEvent): Record<string, unknown>;
}

/** A persisted projection row used as the comparison baseline. */
export interface PersistedProjection {
  eventId: string;
  output: Record<string, unknown>;
}

export interface ReplayOptions {
  runId: string;
  indexerId: string;
  targetVersion: number;
  batchSize: number;
  /** Resume from this event id (exclusive) for partial-replay retries. */
  resumeAfterEventId?: string | null;
}

export interface ReplayResult {
  runId: string;
  status: ReplayStatus;
  replayedCount: number;
  mismatchCount: number;
  firstMismatch: ReplayMismatch | null;
  lastEventId: string | null;
  error: string | null;
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
      | "REPLAY_MISMATCH"
      | "REPLAY_FAILED"
      | "QUEUE_CLOSED"
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

// ── Config ────────────────────────────────────────────────────────────────────

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new IndexerError(
      `${name} must be a positive integer (got ${value})`,
      "CONFIG_ERROR"
    );
  }
  return parsed;
}

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

  const replayTargetRaw = process.env.REPLAY_TARGET_VERSION;
  let replayTargetVersion: number | null = null;
  if (replayTargetRaw !== undefined && replayTargetRaw !== "") {
    replayTargetVersion = positiveInt(replayTargetRaw, 1, "REPLAY_TARGET_VERSION");
  }

  return {
    databaseUrl,
    contractIds,
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    networkPassphrase: process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET,
    pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS ?? 5),
    ledgerLookback: Number(process.env.LEDGER_LOOKBACK ?? 1_000),
    maxEventsPerPoll: Number(process.env.MAX_EVENTS_PER_POLL ?? 200),
    indexerId: process.env.INDEXER_ID ?? "fundable_stream_indexer",
    dryRun: process.env.DRY_RUN === "true",
    consumerQueueSize: positiveInt(process.env.CONSUMER_QUEUE_SIZE, 1_000, "CONSUMER_QUEUE_SIZE"),
    consumerConcurrency: positiveInt(process.env.CONSUMER_CONCURRENCY, 4, "CONSUMER_CONCURRENCY"),
    replayBatchSize: positiveInt(process.env.REPLAY_BATCH_SIZE, 500, "REPLAY_BATCH_SIZE"),
    replayTargetVersion,
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
    CREATE TABLE IF NOT EXISTS cdc_replay_runs (
      run_id          TEXT        PRIMARY KEY,
      indexer_id      TEXT        NOT NULL,
      target_version  INTEGER     NOT NULL,
      status          TEXT        NOT NULL,
      last_event_id   TEXT,
      replayed_count  BIGINT      NOT NULL DEFAULT 0,
      mismatch_count  BIGINT      NOT NULL DEFAULT 0,
      first_mismatch  JSONB,
      error           TEXT,
      started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_cdc_replay_runs_indexer
      ON cdc_replay_runs (indexer_id, started_at DESC)
  `);
}

/**
 * Read the last processed ledger for this indexer instance.
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
 * Persist the latest processed ledger sequence.
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

// ── Bounded queue (issue #222) ────────────────────────────────────────────────

/**
 * A bounded async queue with backpressure.
 *
 * Producers `push` items; when the queue is at capacity, `push` awaits until
 * a consumer drains an item. This bounds memory under downstream outages.
 * Consumers `shift` items; when empty, `shift` awaits until an item arrives
 * or the queue is closed.
 *
 * The queue exposes `size`, `capacity`, and `highWaterMark` so operators can
 * observe pressure. `close` unblocks all waiters with a `QUEUE_CLOSED` error.
 */
export class BoundedQueue<T> {
  private readonly items: T[] = [];
  private readonly pushWaiters: Array<() => void> = [];
  private readonly shiftWaiters: Array<(item: T | null) => void> = [];
  private closed = false;
  private _highWaterMark = 0;

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new IndexerError(
        `BoundedQueue capacity must be a positive integer (got ${capacity})`,
        "CONFIG_ERROR"
      );
    }
  }

  get size(): number {
    return this.items.length;
  }

  get highWaterMark(): number {
    return this._highWaterMark;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Enqueue an item. Resolves once the item is accepted; if the queue is at
   * capacity, waits for a consumer to make room (backpressure).
   */
  async push(item: T): Promise<void> {
    if (this.closed) {
      throw new IndexerError("Cannot push to a closed queue", "QUEUE_CLOSED");
    }
    while (this.items.length >= this.capacity) {
      if (this.closed) {
        throw new IndexerError("Queue closed while waiting for capacity", "QUEUE_CLOSED");
      }
      await new Promise<void>((resolve) => this.pushWaiters.push(resolve));
    }
    if (this.closed) {
      throw new IndexerError("Queue closed before item was accepted", "QUEUE_CLOSED");
    }
    this.items.push(item);
    if (this.items.length > this._highWaterMark) {
      this._highWaterMark = this.items.length;
    }
    const waiter = this.shiftWaiters.shift();
    if (waiter) waiter(item);
  }

  /**
   * Dequeue an item. Resolves with the next item, or waits until one is
   * available. Resolves with `null` if the queue is closed and drained.
   */
  async shift(): Promise<T | null> {
    if (this.items.length > 0) {
      const item = this.items.shift() as T;
      const waiter = this.pushWaiters.shift();
      if (waiter) waiter();
      return item;
    }
    if (this.closed) return null;
    return new Promise<T | null>((resolve) => this.shiftWaiters.push(resolve));
  }

  /** Close the queue, unblocking all waiters. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pushWaiters.splice(0)) waiter();
    for (const waiter of this.shiftWaiters.splice(0)) waiter(null);
  }
}

/**
 * Run a bounded-concurrency consumer over a queue.
 *
 * Spawns up to `concurrency` workers that pull from `queue` and invoke
 * `handler`. Returns a promise that resolves when the queue is closed and
 * drained. Errors from `handler` are surfaced via `onError` and do not stop
 * the workers (retry is the caller's responsibility).
 */
export async function runConsumerPool<T>(
  queue: BoundedQueue<T>,
  concurrency: number,
  handler: (item: T) => Promise<void>,
  onError?: (err: Error, item: T) => void
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new IndexerError(
      `Consumer concurrency must be a positive integer (got ${concurrency})`,
      "CONFIG_ERROR"
    );
  }

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(
      (async () => {
        for (;;) {
          const item = await queue.shift();
          if (item === null) return;
          try {
            await handler(item);
          } catch (err) {
            if (onError) onError(err as Error, item);
            else log("error", "Consumer handler failed", { error: (err as Error).message });
          }
        }
      })()
    );
  }
  await Promise.all(workers);
}

// ── Replay engine (issue #220) ────────────────────────────────────────────────

/** Deterministic JSON serialization for projection comparison. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Compare a replayed projection against the persisted baseline.
 * Returns the first mismatch, or `null` if they match.
 */
export function compareProjections(
  eventId: string,
  replayed: Record<string, unknown>,
  persisted: Record<string, unknown> | undefined
): ReplayMismatch | null {
  if (persisted === undefined) {
    return { eventId, field: "<row>", expected: "present", actual: "missing" };
  }
  const keys = new Set([...Object.keys(replayed), ...Object.keys(persisted)]);
  for (const key of [...keys].sort()) {
    const a = stableStringify(replayed[key]);
    const b = stableStringify(persisted[key]);
    if (a !== b) {
      return { eventId, field: key, expected: persisted[key], actual: replayed[key] };
    }
  }
  return null;
}

/**
 * Read retained raw events ordered deterministically, resuming after
 * `resumeAfterEventId` (exclusive) for partial-replay retries.
 */
export async function readRetainedEvents(
  db: DbClient,
  indexerId: string,
  limit: number,
  resumeAfterEventId?: string | null
): Promise<StreamEvent[]> {
  const params: unknown[] = [];
  let where = "";
  if (resumeAfterEventId) {
    // Resume strictly after the last successfully replayed event, ordered by
    // (ledger_sequence, event_id) to match the replay ordering.
    params.push(resumeAfterEventId);
    where = `WHERE (ledger_sequence, event_id) > (
      SELECT ledger_sequence, event_id FROM stream_events WHERE event_id = $1
    )`;
  }
  params.push(limit);

  const result = await db.query<{
    event_id: string;
    contract_id: string;
    event_type: string;
    ledger_sequence: string;
    ledger_timestamp: string;
    tx_hash: string;
    sender: string | null;
    recipient: string | null;
    asset: string | null;
    amount: string | null;
    stream_id: string | null;
    raw_xdr: string;
  }>(
    `SELECT event_id, contract_id, event_type, ledger_sequence, ledger_timestamp,
            tx_hash, sender, recipient, asset, amount, stream_id, raw_xdr
       FROM stream_events
       ${where}
      ORDER BY ledger_sequence ASC, event_id ASC
      LIMIT $${params.length}`,
    params
  );

  return result.rows.map((row) => ({
    eventId: row.event_id,
    contractId: row.contract_id,
    eventType: row.event_type as StreamEventType,
    ledgerSequence: Number(row.ledger_sequence),
    ledgerTimestamp:
      row.ledger_timestamp instanceof Date
        ? (row.ledger_timestamp as unknown as Date).toISOString()
        : String(row.ledger_timestamp),
    txHash: row.tx_hash,
    sender: row.sender,
    recipient: row.recipient,
    asset: row.asset,
    amount: row.amount,
    streamId: row.stream_id,
    rawXdr: row.raw_xdr,
  }));
}

/**
 * Read the persisted projection baseline for the given event ids.
 */
export async function readPersistedProjections(
  db: DbClient,
  eventIds: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (eventIds.length === 0) return map;

  const result = await db.query<{
    event_id: string;
    contract_id: string;
    event_type: string;
    ledger_sequence: string;
    ledger_timestamp: string;
    tx_hash: string;
    sender: string | null;
    recipient: string | null;
    asset: string | null;
    amount: string | null;
    stream_id: string | null;
  }>(
    `SELECT event_id, contract_id, event_type, ledger_sequence, ledger_timestamp,
            tx_hash, sender, recipient, asset, amount, stream_id
       FROM stream_events
      WHERE event_id = ANY($1::text[])`,
    [eventIds]
  );

  for (const row of result.rows) {
    map.set(row.event_id, {
      eventId: row.event_id,
      contractId: row.contract_id,
      eventType: row.event_type,
      ledgerSequence: Number(row.ledger_sequence),
      ledgerTimestamp:
        row.ledger_timestamp instanceof Date
          ? (row.ledger_timestamp as unknown as Date).toISOString()
          : String(row.ledger_timestamp),
      txHash: row.tx_hash,
      sender: row.sender,
      recipient: row.recipient,
      asset: row.asset,
      amount: row.amount,
      streamId: row.stream_id,
    });
  }
  return map;
}

/** Persist replay run status for operator visibility. */
export async function upsertReplayRun(
  db: DbClient,
  run: ReplayRun
): Promise<void> {
  await db.query(
    `INSERT INTO cdc_replay_runs (
       run_id, indexer_id, target_version, status, last_event_id,
       replayed_count, mismatch_count, first_mismatch, error, started_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (run_id) DO UPDATE SET
       status = EXCLUDED.status,
       last_event_id = EXCLUDED.last_event_id,
       replayed_count = EXCLUDED.replayed_count,
       mismatch_count = EXCLUDED.mismatch_count,
       first_mismatch = EXCLUDED.first_mismatch,
       error = EXCLUDED.error,
       updated_at = NOW()`,
    [
      run.runId,
      run.indexerId,
      run.targetVersion,
      run.status,
      run.lastEventId,
      run.replayedCount,
      run.mismatchCount,
      run.firstMismatch ? JSON.stringify(run.firstMismatch) : null,
      run.error,
      run.startedAt,
    ]
  );
}

/** Read a replay run by id, or `null` if it does not exist. */
export async function getReplayRun(
  db: DbClient,
  runId: string
): Promise<ReplayRun | null> {
  const result = await db.query<{
    run_id: string;
    indexer_id: string;
    target_version: number;
    status: string;
    last_event_id: string | null;
    replayed_count: string;
    mismatch_count: string;
    first_mismatch: ReplayMismatch | null;
    error: string | null;
    started_at: string;
    updated_at: string;
  }>(
    `SELECT run_id, indexer_id, target_version, status, last_event_id,
            replayed_count, mismatch_count, first_mismatch, error,
            started_at, updated_at
       FROM cdc_replay_runs
      WHERE run_id = $1`,
    [runId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    runId: row.run_id,
    indexerId: row.indexer_id,
    targetVersion: Number(row.target_version),
    status: row.status as ReplayStatus,
    lastEventId: row.last_event_id,
    replayedCount: Number(row.replayed_count),
    mismatchCount: Number(row