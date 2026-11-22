/**
 * @module @fundable/sdk
 *
 * Event consumption recipes for the Fundable Stellar SDK.
 *
 * Provides patterns for consuming Soroban contract event streams,
 * parsing payment-stream events, and handling event processing
 * with safe error recovery.
 */

import type {
  ContractEventRaw,
  PaymentStreamContractEvent,
} from "../utils/events.js";
import {
  parsePaymentStreamContractEvent,
  parsePaymentStreamContractEvents,
} from "../utils/events.js";

export type { ContractEventRaw };

/**
 * Canonical mapping of a single raw contract event to a projection.
 *
 * Every raw event produces exactly one mapping entry, so unknown or
 * unsupported event versions are retained (with their raw payload)
 * rather than silently dropped.
 *
 * - `kind: "parsed"` — the event matched a supported schema version and
 *   `event` holds the typed projection.
 * - `kind: "unknown"` — the event could not be mapped (unknown event
 *   name, unsupported version, or malformed payload). `raw` holds the
 *   original event so callers can persist, forward, or alert on it.
 */
export type ContractEventMapping =
  | {
      kind: "parsed";
      /** Event name as reported by the contract (e.g. "StreamDeposit"). */
      eventName: string;
      /** Schema version reported by the contract, when present. */
      version?: string;
      /** Typed projection of the event. */
      event: PaymentStreamContractEvent;
      /** Original raw event, retained for auditability. */
      raw: ContractEventRaw;
    }
  | {
      kind: "unknown";
      /** Event name as reported by the contract, when present. */
      eventName?: string;
      /** Schema version reported by the contract, when present. */
      version?: string;
      /** Reason the event could not be mapped. */
      reason: "unsupported-event" | "unsupported-version" | "malformed-payload";
      /** Original raw event, retained so nothing is lost. */
      raw: ContractEventRaw;
    };

/**
 * Reads the event name from a raw contract event, tolerating the
 * different shapes the RPC may return.
 */
function readEventName(event: ContractEventRaw): string | undefined {
  const candidate = event as unknown as {
    eventName?: unknown;
    name?: unknown;
    type?: unknown;
  };
  for (const value of [candidate.eventName, candidate.name, candidate.type]) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Reads the schema version from a raw contract event, when present.
 */
function readEventVersion(event: ContractEventRaw): string | undefined {
  const candidate = event as unknown as {
    version?: unknown;
    schemaVersion?: unknown;
  };
  for (const value of [candidate.version, candidate.schemaVersion]) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

/**
 * Maps a single raw contract event to its canonical projection.
 *
 * Supported event names/versions are projected into typed events.
 * Anything else is returned as an `unknown` mapping that retains the
 * raw payload, so consumers can persist or forward it without data loss.
 *
 * @param event - Raw contract event from the RPC.
 * @returns Canonical mapping for the event.
 */
export function mapContractEvent(event: ContractEventRaw): ContractEventMapping {
  const eventName = readEventName(event);
  const version = readEventVersion(event);

  const parsed = parsePaymentStreamContractEvent(event);
  if (parsed) {
    return {
      kind: "parsed",
      eventName: eventName ?? parsed.type,
      version,
      event: parsed,
      raw: event,
    };
  }

  let reason: "unsupported-event" | "unsupported-version" | "malformed-payload";
  if (!eventName) {
    reason = "malformed-payload";
  } else if (version !== undefined) {
    reason = "unsupported-version";
  } else {
    reason = "unsupported-event";
  }

  return { kind: "unknown", eventName, version, reason, raw: event };
}

/**
 * Maps a batch of raw contract events to canonical projections.
 *
 * The returned array has the same length and ordering as the input;
 * unknown events are retained rather than filtered out.
 *
 * @param events - Raw contract events from the RPC.
 * @returns One mapping per input event, in input order.
 */
export function mapContractEvents(
  events: readonly ContractEventRaw[] | undefined,
): ContractEventMapping[] {
  const rawList = Array.isArray(events) ? events : [];
  return rawList.map((event) => mapContractEvent(event));
}

/**
 * Result of consuming events from a contract.
 */
export interface EventConsumptionResult {
  /** Total events retrieved from the RPC. */
  totalRetrieved: number;
  /** Events successfully parsed into typed events. */
  parsedEvents: PaymentStreamContractEvent[];
  /** Events that could not be parsed (unknown or malformed). */
  unparsedEvents: ContractEventRaw[];
  /**
   * Canonical mapping for every retrieved event, in input order.
   * Unknown events are retained here with their raw payloads.
   */
  mappings: ContractEventMapping[];
  /** Cursor/token for pagination (if supported by the RPC). */
  cursor?: string;
}

/**
 * Parses raw Soroban contract events into typed payment-stream events.
 * Returns both successfully parsed events and any that could not be
 * parsed, so callers can decide how to handle unknown event types.
 *
 * Compatibility guarantees:
 * - Every retrieved event appears exactly once in `mappings`, in input
 *   order, regardless of whether it is a supported version.
 * - Unknown event names, unsupported schema versions, and malformed
 *   payloads are retained in `unparsedEvents` and as `kind: "unknown"`
 *   mappings with their original raw payload. Nothing is dropped.
 * - `parsedEvents` contains only supported projections; its contents are
 *   unchanged from previous releases.
 *
 * @param events - Raw contract events from the RPC.
 * @returns Consumption result with parsed, unparsed, and mapped events.
 *
 * @example
 * ```typescript
 * import { consumeContractEvents } from "@fundable/sdk";
 *
 * const rawEvents = await server.getEvents({ contractIds: [contractId] });
 * const result = consumeContractEvents(rawEvents);
 *
 * for (const event of result.parsedEvents) {
 *   console.log(`${event.type} on ${event.contractId}:`, event.payload);
 * }
 *
 * for (const mapping of result.mappings) {
 *   if (mapping.kind === "unknown") {
 *     console.warn(
 *       `Unmapped event ${mapping.eventName ?? "<unnamed>"} ` +
 *         `(version ${mapping.version ?? "n/a"}): ${mapping.reason}`,
 *     );
 *   }
 * }
 * ```
 */
export function consumeContractEvents(
  events: readonly ContractEventRaw[] | undefined,
): EventConsumptionResult {
  const rawList = Array.isArray(events) ? events : [];

  const parsedEvents: PaymentStreamContractEvent[] = [];
  const unparsedEvents: ContractEventRaw[] = [];
  const mappings: ContractEventMapping[] = [];

  for (const event of rawList) {
    const mapping = mapContractEvent(event);
    mappings.push(mapping);
    if (mapping.kind === "parsed") {
      parsedEvents.push(mapping.event);
    } else {
      unparsedEvents.push(event);
    }
  }

  return {
    totalRetrieved: rawList.length,
    parsedEvents,
    unparsedEvents,
    mappings,
  };
}

/**
 * Filters parsed events by type name. Useful when you only care about
 * specific event kinds (e.g., only `StreamDeposit` events).
 *
 * @param events - Parsed contract events.
 * @param eventType - Event type name to filter by (e.g., "StreamDeposit").
 * @returns Events matching the given type.
 *
 * @example
 * ```typescript
 * import { filterEventsByType } from "@fundable/sdk";
 *
 * const deposits = filterEventsByType(result.parsedEvents, "StreamDeposit");
 * for (const deposit of deposits) {
 *   console.log("Deposit:", deposit.payload.amount, "to stream", deposit.payload.stream_id);
 * }
 * ```
 */
export function filterEventsByType(
  events: PaymentStreamContractEvent[],
  eventType: string,
): PaymentStreamContractEvent[] {
  return events.filter((event) => event.type === eventType);
}

/**
 * Groups parsed events by contract ID. Useful when consuming events
 * from multiple contracts in a single query.
 *
 * @param events - Parsed contract events.
 * @returns Map of contract ID to its events.
 *
 * @example
 * ```typescript
 * import { groupEventsByContract } from "@fundable/sdk";
 *
 * const byContract = groupEventsByContract(result.parsedEvents);
 * for (const [contractId, events] of byContract) {
 *   console.log(`Contract ${contractId}: ${events.length} events`);
 * }
 * ```
 */
export function groupEventsByContract(
  events: PaymentStreamContractEvent[],
): Map<string, PaymentStreamContractEvent[]> {
  const grouped = new Map<string, PaymentStreamContractEvent[]>();
  for (const event of events) {
    const existing = grouped.get(event.contractId) ?? [];
    existing.push(event);
    grouped.set(event.contractId, existing);
  }
  return grouped;
}

/**
 * Extracts all stream deposit events from parsed contract events.
 * Convenience helper for the common case of tracking incoming payments.
 *
 * @param events - Parsed contract events.
 * @returns Stream deposit events with their payloads.
 *
 * @example
 * ```typescript
 * import { getStreamDeposits } from "@fundable/sdk";
 *
 * const deposits = getStreamDeposits(result.parsedEvents);
 * const totalDeposited = deposits.reduce(
 *   (sum, d) => sum + d.payload.amount,
 *   0n,
 * );
 * ```
 */
export function getStreamDeposits(
  events: PaymentStreamContractEvent[],
): PaymentStreamContractEvent[] {
  return filterEventsByType(events, "StreamDeposit");
}

/**
 * Extracts all stream pause/resume events from parsed contract events.
 *
 * @param events - Parsed contract events.
 * @returns Pause and resume events.
 *
 * @example
 * ```typescript
 * import { getStreamPauses } from "@fundable/sdk";
 *
 * const pauses = getStreamPauses(result.parsedEvents);
 * for (const pause of pauses) {
 *   if (pause.type === "StreamPaused") {
 *     console.log("Stream paused at ledger:", pause.payload.paused_at);
 *   }
 * }
 * ```
 */
export function getStreamPauses(
  events: PaymentStreamContractEvent[],
): PaymentStreamContractEvent[] {
  return events.filter(
    (event) => event.type === "StreamPaused" || event.type === "StreamResumed",
  );
}