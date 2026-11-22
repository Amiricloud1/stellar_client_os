/**
 * SorobanEventParser
 *
 * A class-based, type-safe utility for parsing raw Soroban contract events
 * emitted by Fundable smart contracts. Designed for dApp developers who need
 * to react to on-chain actions in a structured, predictable way.
 *
 * Supports both PaymentStream and Distributor contract event streams.
 *
 * @example
 * ```ts
 * const parser = new SorobanEventParser({ contractId: "C..." });
 * const events = parser.parseAll(rawEvents);
 * const paused = parser.filter(events, "StreamPaused");
 * ```
 */

import {
  parsePaymentStreamContractEvent,
  parsePaymentStreamContractEvents,
  type ContractEventRaw,
  type PaymentStreamContractEvent,
  type PaymentStreamContractEventType,
  PAYMENT_STREAM_EVENT_TYPES,
} from "./events.js";
import {
  mapContractEvent,
  type ContractEventMapping,
  type UnknownContractEvent,
} from "./contractEventMapping.js";

export type { ContractEventRaw, PaymentStreamContractEvent, PaymentStreamContractEventType };
export { PAYMENT_STREAM_EVENT_TYPES };
export type { ContractEventMapping, UnknownContractEvent };

export interface SorobanEventParserOptions {
  /** Optional contract ID to scope parsing to a specific contract. */
  contractId?: string;
  /**
   * Optional network scope (e.g. "testnet", "mainnet"). When set, events whose
   * `network` field does not match are excluded from this parser's partition.
   */
  network?: string;
  /**
   * Optional deployment ID scope. When set, events whose `deployment_id` field
   * does not match are excluded from this parser's partition.
   */
  deploymentId?: string;
}

export interface ParseResult<T> {
  /** Events mapped to a known, supported contract-event projection. */
  parsed: T[];
  /**
   * Events whose version/topic is not supported. Payloads are retained
   * verbatim so callers can persist or forward them for later processing.
   */
  unknown: UnknownContractEvent[];
  /**
   * Raw events that could not be parsed at all (malformed payloads).
   * These are surfaced explicitly rather than silently dropped.
   */
  skipped: ContractEventRaw[];
}

/**
 * Identifies an ingestion partition. Cursors, backfills and health are tracked
 * per partition so a stalled source cannot block other deployments.
 */
export interface EventPartition {
  network: string;
  deploymentId: string;
}

/**
 * Per-partition parse results. Each partition is isolated: malformed events in
 * one partition never affect the parsed/skipped results of another.
 */
export interface PartitionedParseResult<T> {
  /** Results keyed by a stable partition key (`network:deploymentId`). */
  partitions: Map<string, ParseResult<T>>;
  /** Events that could not be attributed to any partition. */
  unattributed: ContractEventRaw[];
}

/** Builds the stable key used to group events by partition. */
export function partitionKey(partition: EventPartition): string {
  return `${partition.network}:${partition.deploymentId}`;
}

/**
 * Extracts the partition an event belongs to, or `null` when the event does not
 * carry enough information to be attributed.
 */
export function eventPartition(event: ContractEventRaw): EventPartition | null {
  const network = (event as { network?: unknown }).network;
  const deploymentId = (event as { deployment_id?: unknown }).deployment_id;
  if (typeof network !== "string" || network.length === 0) return null;
  if (typeof deploymentId !== "string" || deploymentId.length === 0) return null;
  return { network, deploymentId };
}

export class SorobanEventParser {
  private readonly contractId?: string;
  private readonly network?: string;
  private readonly deploymentId?: string;

  constructor(options: SorobanEventParserOptions = {}) {
    this.contractId = options.contractId;
    this.network = options.network;
    this.deploymentId = options.deploymentId;
  }

  /**
   * Returns true when the event belongs to this parser's configured partition.
   * Unset scopes match everything.
   */
  private inScope(event: ContractEventRaw): boolean {
    if (this.contractId && event.contract_id !== this.contractId) {
      return false;
    }
    if (this.network !== undefined) {
      const network = (event as { network?: unknown }).network;
      if (network !== this.network) return false;
    }
    if (this.deploymentId !== undefined) {
      const deploymentId = (event as { deployment_id?: unknown }).deployment_id;
      if (deploymentId !== this.deploymentId) return false;
    }
    return true;
  }

  /**
   * Parse a single raw event. Returns `null` if the event is out of scope,
   * unrecognized, or has a malformed payload.
   */
  parse(event: ContractEventRaw): PaymentStreamContractEvent | null {
    if (!this.inScope(event)) {
      return null;
    }
    return mapContractEvent(event);
  }

  /**
   * Parse a single raw event. Returns `null` if the event is filtered out by
   * the configured `contractId` or if the payload is malformed. Unknown event
   * versions are returned as an `unknown` mapping (payload retained).
   */
  parse(event: ContractEventRaw): PaymentStreamContractEvent | UnknownContractEvent | null {
    const mapping = this.map(event);
    if (mapping === null || mapping.kind === "malformed") {
      return null;
    }
    return mapping.event;
  }

  /**
   * Parse an array of raw events, partitioning them into supported
   * projections (`parsed`), retained unknown versions (`unknown`), and
   * malformed payloads (`skipped`).
   */
  parseAll(events: readonly ContractEventRaw[]): ParseResult<PaymentStreamContractEvent> {
    const parsed: PaymentStreamContractEvent[] = [];
    const unknown: UnknownContractEvent[] = [];
    const skipped: ContractEventRaw[] = [];

    for (const event of events) {
      const mapping = this.map(event);
      if (mapping === null) {
        continue;
      }
      switch (mapping.kind) {
        case "known":
          parsed.push(mapping.event);
          break;
        case "unknown":
          unknown.push(mapping.event);
          break;
        case "malformed":
          skipped.push(event);
          break;
      }
    }

    return { parsed, unknown, skipped };
  }

  /**
   * Parse raw events grouped by (network, deploymentId) partition. Each
   * partition is parsed independently so a malformed event in one partition
   * cannot affect the results of another. Events that cannot be attributed to
   * a partition are returned in `unattributed`.
   *
   * When this parser is scoped to a specific network/deploymentId, only that
   * partition is included in the result.
   */
  parsePartitioned(
    events: readonly ContractEventRaw[],
  ): PartitionedParseResult<PaymentStreamContractEvent> {
    const partitions = new Map<string, ParseResult<PaymentStreamContractEvent>>();
    const unattributed: ContractEventRaw[] = [];

    for (const event of events) {
      const partition = eventPartition(event);
      if (partition === null) {
        unattributed.push(event);
        continue;
      }
      if (this.network !== undefined && partition.network !== this.network) {
        continue;
      }
      if (this.deploymentId !== undefined && partition.deploymentId !== this.deploymentId) {
        continue;
      }

      const key = partitionKey(partition);
      let bucket = partitions.get(key);
      if (bucket === undefined) {
        bucket = { parsed: [], skipped: [] };
        partitions.set(key, bucket);
      }

      const result = this.parse(event);
      if (result !== null) {
        bucket.parsed.push(result);
      } else {
        bucket.skipped.push(event);
      }
    }

    return { partitions, unattributed };
  }

  /**
   * Filter already-parsed events by event type with full type narrowing.
   *
   * @example
   * const paused = parser.filter(events, "StreamPaused");
   * // paused[0].payload.paused_at is typed as bigint
   */
  filter<T extends PaymentStreamContractEventType>(
    events: PaymentStreamContractEvent[],
    type: T,
  ): Extract<PaymentStreamContractEvent, { type: T }>[] {
    return events.filter(
      (e): e is Extract<PaymentStreamContractEvent, { type: T }> => e.type === type,
    );
  }

  /**
   * Convenience: parse raw events and immediately filter by type.
   */
  parseAndFilter<T extends PaymentStreamContractEventType>(
    rawEvents: readonly ContractEventRaw[],
    type: T,
  ): Extract<PaymentStreamContractEvent, { type: T }>[] {
    const { parsed } = this.parseAll(rawEvents);
    return this.filter(parsed, type);
  }

  /**
   * Convenience: parse raw events and return only the retained unknown
   * (unsupported version) events.
   */
  parseUnknown(rawEvents: readonly ContractEventRaw[]): UnknownContractEvent[] {
    return this.parseAll(rawEvents).unknown;
  }

  /**
   * Returns true if the given event type string is a known PaymentStream event.
   */
  static isKnownEventType(value: string): value is PaymentStreamContractEventType {
    return (PAYMENT_STREAM_EVENT_TYPES as readonly string[]).includes(value);
  }
}
