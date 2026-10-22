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
 * Result of consuming events from a contract.
 */
export interface EventConsumptionResult {
  /** Total events retrieved from the RPC. */
  totalRetrieved: number;
  /** Events successfully parsed into typed events. */
  parsedEvents: PaymentStreamContractEvent[];
  /** Events that could not be parsed (unknown or malformed). */
  unparsedEvents: ContractEventRaw[];
  /** Cursor/token for pagination (if supported by the RPC). */
  cursor?: string;
}

/**
 * Parses raw Soroban contract events into typed payment-stream events.
 * Returns both successfully parsed events and any that could not be
 * parsed, so callers can decide how to handle unknown event types.
 *
 * @param events - Raw contract events from the RPC.
 * @returns Consumption result with parsed and unparsed events.
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
 * if (result.unparsedEvents.length > 0) {
 *   console.warn(`${result.unparsedEvents.length} events could not be parsed`);
 * }
 * ```
 */
export function consumeContractEvents(
  events: readonly ContractEventRaw[] | undefined,
): EventConsumptionResult {
  const rawList = Array.isArray(events) ? events : [];

  const parsedEvents: PaymentStreamContractEvent[] = [];
  const unparsedEvents: ContractEventRaw[] = [];

  for (const event of rawList) {
    const parsed = parsePaymentStreamContractEvent(event);
    if (parsed) {
      parsedEvents.push(parsed);
    } else {
      unparsedEvents.push(event);
    }
  }

  return {
    totalRetrieved: rawList.length,
    parsedEvents,
    unparsedEvents,
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