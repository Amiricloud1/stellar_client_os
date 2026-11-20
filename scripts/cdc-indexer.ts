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
 *   3. Persist a minimal, integrity-checkable raw envelope per source event
 *      (`raw_event_envelopes`) and link derived rows to it via `envelope_id`.
 *   4. Write new events to `stream_events` table via an UPSERT
 *      (idempotent on `event_id`).
 *   5. Persist the latest processed ledger sequence in `cdc_cursors`
 *      so restarts resume from the correct position without gaps or
 *      duplicate processing.
 *
 * # Auditability & retention (issues #223 / #224)
 *
 *   - `raw_event_envelopes` retains a *minimal* raw envelope per event:
 *     the event id, contract, ledger, tx hash, topic XDR, value XDR and a
 *     SHA-256 digest over the canonical envelope payload. The digest lets
 *     auditors verify that a derived `stream_events` row was produced from
 *     an unmodified source event.
 *   - `archived_event_summaries` compacts high-volume raw events older than
 *     the retention window into per-(contract, time-range) summaries while
 *     preserving the agreed history queries. Compaction is idempotent and
 *     safe to retry.
 *   - `queryEventHistory` routes reads to the archive when raw rows have
 *     been compacted, so audit queries keep working.
 *   - `reconstructEventDetail` rebuilds full detail from archives plus
 *     retained envelopes (the tested reconstruction path).
 *
 * # Table schemas
 *
 * ```sql
 * CREATE TABLE IF NOT EXISTS stream_events (
 *   id              BIGSERIAL PRIMARY KEY,
 *   event_id        TEXT        NOT NULL UNIQUE,   -- <ledger>-<tx_index>-<event_index>
 *   envelope_id     TEXT,                          -- FK -> raw_event_envelopes.event_id
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
 * CREATE TABLE IF NOT EXISTS raw_event_envelopes (
 *   event_id         TEXT        PRIMARY KEY,
 *   contract_id      TEXT        NOT NULL,
 *   ledger_sequence  BIGINT      NOT NULL,
 *   ledger_timestamp TIMESTAMPTZ NOT NULL,
 *   tx_hash          TEXT        NOT NULL,
 *   topic_xdr        JSONB       NOT NULL DEFAULT '[]'::jsonb,
 *   value_xdr        TEXT        NOT NULL,
 *   digest           TEXT        NOT NULL,          -- sha256 of canonical payload
 *   compacted        BOOLEAN     NOT NULL DEFAULT FALSE,
 *   archived_at      TIMESTAMPTZ,
 *   created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
 * );
 *
 * CREATE TABLE IF NOT EXISTS archived_event_summaries (
 *   id              BIGSERIAL PRIMARY KEY,
 *   contract_id     TEXT        NOT NULL,
 *   range_start     TIMESTAMPTZ NOT NULL,
 *   range_end       TIMESTAMPTZ NOT NULL,
 *   event_count     BIGINT      NOT NULL,
 *   event_type_counts JSONB     NOT NULL,
 *   first_ledger    BIGINT      NOT NULL,
 *   last_ledger     BIGINT      NOT NULL,
 *   digest          TEXT        NOT NULL,           -- sha256 over member digests
 *   created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *   UNIQUE (contract_id, range_start, range_end)
 * );
 *
 * CREATE TABLE IF NOT EXISTS cdc_cursors (
 *   indexer_id      TEXT        PRIMARY KEY,
 *   last_ledger     BIGINT      NOT NULL,
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
 * | RETENTION_DAYS        | ✗        | 30                                       | Raw events older than this are compacted |
 * | COMPACTION_RANGE_HOURS| ✗        | 24                                       | Width of each archived summary bucket |
 * | COMPACTION_INTERVAL_SECONDS | ✗  | 3600                                     | Seconds between compaction runs |
 *
 * # Running
 *
 *   pnpm tsx scripts/cdc-indexer.ts
 */

import { Pool, type PoolClient } from "pg";
import { createHash } from "crypto";
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
  /** Envelope id linking this derived row to its source envelope */
  envelopeId: string | null;
}

/**
 * Minimal, integrity-checkable raw envelope retained for auditability.
 * Only the fields required to verify and reconstruct a derived event are kept.
 */
export interface RawEventEnvelope {
  eventId: string;
  contractId: string;
  ledgerSequence: number;
  /** ISO 8601 timestamp */
  ledgerTimestamp: string;
  txHash: string;
  /** Base64 XDR of each topic ScVal */
  topicXdr: string[];
  /** Base64 XDR of the event value ScVal */
  valueXdr: string;
  /** SHA-256 digest over the canonical envelope payload */
  digest: string;
}

export interface ArchivedEventSummary {
  id: number;
  contractId: string;
  rangeStart: string;
  rangeEnd: string;
  eventCount: number;
  eventTypeCounts: Record<string, number>;
  firstLedger: number;
  lastLedger: number;
  digest: string;
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
  /** Raw events older than this many days are eligible for compaction. */
  retentionDays: number;
  /** Width in hours of each archived summary bucket. */
  compactionRangeHours: number;
  /** Seconds between compaction runs. */
  compactionIntervalSeconds: number;
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
      | "AUTH_ERROR"
      | "COMPACTION_ERROR"
      | "RECONSTRUCTION_ERROR"
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
    retentionDays: Number(process.env.RETENTION_DAYS ?? 30),
    compactionRangeHours: Number(process.env.COMPACTION_RANGE_HOURS ?? 24),
    compactionIntervalSeconds: Number(process.env.COMPACTION_INTERVAL_SECONDS ?? 3_600),
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
      envelope_id      TEXT,
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

  // Migration for pre-existing deployments: add envelope_id if missing.
  await db.query(`
    ALTER TABLE stream_events
      ADD COLUMN IF NOT EXISTS envelope_id TEXT
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
    CREATE INDEX IF NOT EXISTS idx_stream_events_envelope
      ON stream_events (envelope_id) WHERE envelope_id IS NOT NULL
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS raw_event_envelopes (
      event_id         TEXT        PRIMARY KEY,
      contract_id      TEXT        NOT NULL,
      ledger_sequence  BIGINT      NOT NULL,
      ledger_timestamp TIMESTAMPTZ NOT NULL,
      tx_hash          TEXT        NOT NULL,
      topic_xdr        JSONB       NOT NULL DEFAULT '[]'::jsonb,
      value_xdr        TEXT        NOT NULL,
      digest           TEXT        NOT NULL,
      compacted        BOOLEAN     NOT NULL DEFAULT FALSE,
      archived_at      TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_raw_event_envelopes_contract_ledger
      ON raw_event_envelopes (contract_id, ledger_sequence)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_raw_event_envelopes_compaction
      ON raw_event_envelopes (ledger_timestamp) WHERE compacted = FALSE
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS archived_event_summaries (
      id                BIGSERIAL   PRIMARY KEY,
      contract_id       TEXT        NOT NULL,
      range_start       TIMESTAMPTZ NOT NULL,
      range_end         TIMESTAMPTZ NOT NULL,
      event_count       BIGINT      NOT NULL,
      event_type_counts JSONB       NOT NULL,
      first_ledger      BIGINT      NOT NULL,
      last_ledger       BIGINT      NOT NULL,
      digest            TEXT        NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (contract_id, range_start, range_end)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_archived_event_summaries_contract_range
      ON archived_event_summaries (contract_id, range_start, range_end)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cdc_cursors (
      indexer_id  TEXT        PRIMARY KEY,
      last_ledger BIGINT      NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sponsor_signups (
      sponsor_address TEXT PRIMARY KEY,
      signup_date     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sponsorships (
      id              BIGSERIAL PRIMARY KEY,
      sponsor_address TEXT        NOT NULL REFERENCES sponsor_signups(sponsor_address),
      stream_id       TEXT        NOT NULL,
      amount          NUMERIC     NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_sponsorships_sponsor_address ON sponsorships(sponsor_address)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_sponsorships_created_at ON sponsorships(created_at)
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

// ── Raw envelope helpers ──────────────────────────────────────────────────────

/**
 * Compute the canonical SHA-256 digest for an envelope. The digest covers
 * the fields that determine the derived event, so an auditor can re-derive
 * it from the retained envelope and compare against the stored value.
 */
export function computeEnvelopeDigest(
  envelope: Omit<RawEventEnvelope, "digest">
): string {
  const canonical = JSON.stringify({
    eventId: envelope.eventId,
    contractId: envelope.contractId,
    ledgerSequence: envelope.ledgerSequence,
    ledgerTimestamp: envelope.ledgerTimestamp,
    txHash: envelope.txHash,
    topicXdr: envelope.topicXdr,
    valueXdr: envelope.valueXdr,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Build a minimal raw envelope from a raw Soroban event.
 */
export function buildEnvelope(
  rawEvent: SorobanEvent,
  ledgerSequence: number,
  ledgerTimestamp: number
): RawEventEnvelope {
  const eventId = `${ledgerSequence}-${rawEvent.id ?? "0"}`;
  const topicXdr = (rawEvent.topic ?? []).map((t) => String(t));
  const valueXdr = rawEvent.value?.xdr ?? "";
  const base = {
    eventId,
    contractId: rawEvent.contractId ?? "",
    ledgerSequence,
    ledgerTimestamp: new Date(ledgerTimestamp * 1_000).toISOString(),
    txHash: rawEvent.txHash ?? "",
    topicXdr,
    valueXdr,
  };
  return { ...base, digest: computeEnvelopeDigest(base) };
}

/**
 * Upsert a batch of raw envelopes. Idempotent on `event_id`.
 * Returns the number of newly inserted envelopes.
 */
export async function insertEnvelopes(
  db: DbClient,
  envelopes: RawEventEnvelope[]
): Promise<number> {
  if (envelopes.length === 0) return 0;

  let inserted = 0;
  for (const env of envelopes) {
    const result = await db.query(
      `INSERT INTO raw_event_envelopes (
         event_id, contract_id, ledger_sequence, ledger_timestamp, tx_hash,
         topic_xdr, value_xdr, digest
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        env.eventId,
        env.contractId,
        env.ledgerSequence,
        env.ledgerTimestamp,
        env.txHash,
        JSON.stringify(env.topicXdr),
        env.valueXdr,
        env.digest,
      ]
    );
    if ((result as unknown as { rowCount: number }).rowCount > 0) inserted++;
  }
  return inserted;
}

/**
 * Upsert a batch of stream events. Idempotent on `event_id`.
 * Each derived row is linked to its source envelope via `envelope_id`.
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
         event_id, envelope_id, contract_id, event_type, ledger_sequence,
         ledger_timestamp, tx_hash, sender, recipient, asset, amount,
         stream_id, raw_xdr
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        ev.eventId,
        ev.envelopeId,
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

    if ((result as unknown as { rowCount: number }).rowCount > 0) {
      inserted++;

      // If it's a stream creation, track the sponsor
      if (ev.eventType === "stream_created" && ev.sender) {
        // Upsert sponsor signup
        await db.query(
          `INSERT INTO sponsor_signups (sponsor_address)
           VALUES ($1)
           ON CONFLICT (sponsor_address) DO NOTHING`,
          [ev.sender]
        );

        // Record the sponsorship
        await db.query(
          `INSERT INTO sponsorships (sponsor_address, stream_id, amount)
           VALUES ($1, $2, $3)`,
          [ev.sender, ev.streamId, ev.amount]
        );
      }
    }
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
    envelopeId: eventId,
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

// ── Compaction (issue #224) ───────────────────────────────────────────────────

export interface CompactionOptions {
  /** Raw events with ledger_timestamp older than this are eligible. */
  retentionDays: number;
  /** Width in hours of each archived summary bucket. */
  rangeHours: number;
  /** Optional contract filter; when omitted all contracts are compacted. */
  contractId?: string;
  /** Optional clock override for deterministic tests. */
  now?: Date;
}

export interface CompactionResult {
  summariesCreated: number;
  envelopesCompacted: number;
  /** Contracts / ranges that failed and can be retried. */
  failures: Array<{ contractId: string; rangeStart: string; rangeEnd: string; error: string }>;
}

interface EnvelopeRow {
  event_id: string;
  contract_id: string;
  ledger_sequence: string;
  ledger_timestamp: string;
  digest: string;
}

/**
 * Compact raw envelopes older than the retention window into
 * `archived_event_summaries`, keyed by (contract, time-range).
 *
 * Idempotent and safe to retry: summaries are UPSERTed on
 * (contract_id, range_start, range_end) and envelopes are only marked
 * `compacted` after their summary is durably written. A crash between the
 * two steps leaves envelopes un-compacted, so the next run re-derives the
 * same summary and completes the marking.
 */
export async function compactEvents(
  db: DbClient,
  options: CompactionOptions
): Promise<CompactionResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.retentionDays * 24 * 60 * 60 * 1_000);
  const rangeMs = options.rangeHours * 60 * 60 * 1_000;

  const result: CompactionResult = {
    summariesCreated: 0,
    envelopesCompacted: 0,
    failures: [],
  };

  const params: unknown[] = [cutoff.toISOString()];
  let contractFilter = "";
  if (options.contractId) {
    params.push(options.contractId);
    contractFilter = `AND contract_id = $${params.length}`;
  }

  const rows = await db.query<EnvelopeRow>(
    `SELECT event_id, contract_id, ledger_sequence, ledger_timestamp, digest
       FROM raw_event_envelopes
      WHERE compacted = FALSE
        AND ledger_timestamp < $1
        ${contractFilter}
      ORDER BY contract_id, ledger_timestamp`,
    params
  );

  if (rows.rows.length === 0) {
    log("info", "Compaction: no eligible envelopes", {
      cutoff: cutoff.toISOString(),
    });
    return result;
  }

  // Group envelopes by (contract, bucket).
  const buckets = new Map<
    string,
    { contractId: string; rangeStart: Date; rangeEnd: Date; rows: EnvelopeRow[] }
  >();

  for (const row of rows.rows) {
    const ts = new Date(row.ledger_timestamp).getTime();
    const bucketStart = Math.floor(ts / rangeMs) * rangeMs;
    const rangeStart = new Date(bucketStart);
    const rangeEnd = new Date(bucketStart + rangeMs);
    const key = `${row.contract_id}|${rangeStart.toISOString()}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { contractId: row.contract_id, rangeStart, rangeEnd, rows: [] };
      buckets.set(key, bucket);
    }
    bucket.rows.push(row);
  }

  for (const bucket of buckets.values()) {
    try {
      const eventTypeCounts: Record<string, number> = {};
      let firstLedger = Number.MAX_SAFE_INTEGER;
      let lastLedger = 0;
      const digests: string[] = [];

      for (const row of bucket.rows) {
        const ledger = Number(row.ledger_sequence);
        if (ledger < firstLedger) firstLedger = ledger;
        if (ledger > lastLedger) lastLedger = ledger;
        digests.push(row.digest);
      }

      // Derive per-type counts from the linked derived rows where available.
      const eventIds = bucket.rows.map((r) => r.event_id);
      const typeRows = await db.query<{ event_type: string; count: string }>(
        `SELECT event_type, COUNT(*)::text AS count
           FROM stream_events
          WHERE event_id = ANY($1::text[])
          GROUP BY event_type`,
        [eventIds]
      );
      for (const tr of typeRows.rows) {
        eventTypeCounts[tr.event_type] = Number(tr.count);
      }

      const summaryDigest = createHash("sha256")
        .update(digests.sort().join(":"))
        .digest("hex");

      // UPSERT summary — idempotent on (contract_id, range_start, range_end).
      await db.query(
        `INSERT INTO archived_event_summaries (
           contract_id, range_start, range_end, event_count, event_type_counts,
           first_ledger, last_ledger, digest
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
         ON CONFLICT (contract_id, range_start, range_end)
         DO UPDATE SET
           event_count = EXCLUDED.event_count,
           event_type_counts = EXCLUDED.event_type_counts,
           first_ledger = EXCLUDED.first_ledger,
           last_ledger = EXCLUDED.last_ledger,
           digest = EXCLUDED.digest`,
        [
          bucket.contractId,
          bucket.rangeStart.toISOString(),
          bucket.rangeEnd.toISOString(),
          bucket.rows.length,
          JSON.stringify(eventTypeCounts),
          firstLedger === Number.MAX_SAFE_INTEGER ? 0 : firstLedger,
          lastLedger,
          summaryDigest,
        ]
      );
      result.summariesCreated++;

      // Mark envelopes compacted only after the summary is durable.
      await db.query(
        `UPDATE raw_event_envelopes
            SET compacted = TRUE, archived_at = NOW()
          WHERE event_id = ANY($1::text[])`,
        [eventIds]
      );
      result.envelopesCompacted += bucket.rows.length;

      log("info", "Compaction: archived bucket", {
        contractId: bucket.contractId,
        rangeStart: bucket.rangeStart.toISOString(),
        rangeEnd: bucket.rangeEnd.toISOString(),
        eventCount: bucket.rows.length,
      });
    } catch (err) {
      const failure = {
        contractId: bucket.contractId,
        rangeStart: bucket.rangeStart.toISOString(),
        rangeEnd: bucket.rangeEnd.toISOString(),
        error: (err as Error).message,
      };
      result.failures.push(failure);
      log("error", "Compaction: bucket failed — will retry next run", failure);
    }
  }

  log("info", "Compaction complete", {
    summariesCreated: result.summariesCreated,
    envelopesCompacted: result.envelopesCompacted,
    failures: result.failures.length,
  });

  return result;
}

// ── Audit queries & reconstruction (issues #223 / #224) ──────────────────────

export interface EventHistoryQuery {
  contractId: string;
  /** ISO 8601 inclusive lower bound. */
  from: string;
  /** ISO 8601 exclusive upper bound. */
  to: string;
  /** Optional authorization scope; when set, must match contractId. */
  authorizedContractId?: string;
}

export interface EventHistoryResult {
  /** Derived events still retained as raw rows. */
  events: StreamEvent[];
  /** Archived summaries covering compacted ranges. */
  archives: ArchivedEventSummary[];
  /** True when some part of the range was served from the archive. */
  servedFromArchive: boolean;
}

/**
 * Query event history for a contract over a time range.
 *
 * Reads are routed to the archive when raw rows have been compacted, so
 * agreed history queries keep working after compaction. Authorization is
 * enforced at this boundary: a caller scoped to a contract may not read
 * another contract's history.
 */
export async function queryEventHistory(
  db: DbClient,
  query: EventHistoryQuery
): Promise<EventHistoryResult> {
  if (
    query.authorizedContractId