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

export class SorobanEventParser {
  private readonly contractId?: string;

  constructor(options: SorobanEventParserOptions = {}) {
    this.contractId = options.contractId;
  }

  /**
   * Map a single raw event through the canonical contract-event mapping layer.
   *
   * Returns `null` only when the event is filtered out by the configured
   * `contractId`. Unknown event versions are returned as an explicit
   * `unknown` mapping with the original payload retained.
   */
  map(event: ContractEventRaw): ContractEventMapping | null {
    if (this.contractId && event.contract_id !== this.contractId) {
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
