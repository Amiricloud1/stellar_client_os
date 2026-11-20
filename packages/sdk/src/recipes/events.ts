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
 * Sponsorship-related event types that feed the sponsor portfolio
 * reconciliation. These events carry the authoritative on-chain value
 * (committed, matched, settled) that must be reconciled against
 * off-chain records.
 */
export const SPONSORSHIP_EVENT_TYPES = [
  "SponsorshipCommitted",
  "SponsorshipMatched",
  "SponsorshipSettled",
  "SponsorshipRefunded",
] as const;

export type SponsorshipEventType = (typeof SPONSORSHIP_EVENT_TYPES)[number];

/**
 * A decoded sponsorship event surfaced for portfolio reconciliation.
 * `sourceRef` points back to the authoritative on-chain record
 * (transaction hash + event index) so operators can audit each value.
 */
export interface SponsorshipEvent {
  /** Sponsorship event type. */
  type: SponsorshipEventType;
  /** Contract that emitted the event. */
  contractId: string;
  /** Ledger at which the event was emitted. */
  ledger: number;
  /** Transaction hash of the emitting transaction. */
  txHash: string;
  /** Index of the event within its transaction (source reference). */
  eventIndex: number;
  /** Campaign the sponsorship belongs to, when present in the payload. */
  campaignId?: string;
  /** Sponsor account, when present in the payload. */
  sponsor?: string;
  /** Amount in stroops, when present in the payload. */
  amount?: bigint;
  /** Raw payload for downstream reconciliation. */
  payload: Record<string, unknown>;
}

/**
 * Reconciliation status for a single sponsorship event.
 * - `reconciled`: matched to an authoritative record.
 * - `unreconciled`: decoded but no authoritative record matched yet.
 * - `partial`: some fields (e.g. amount) could not be decoded.
 */
export type SponsorshipReconciliationStatus =
  | "reconciled"
  | "unreconciled"
  | "partial";

/**
 * Result of decoding sponsorship events for portfolio reconciliation.
 */
export interface SponsorshipEventConsumptionResult {
  /** Total events retrieved from the RPC. */
  totalRetrieved: number;
  /** Successfully decoded sponsorship events. */
  sponsorshipEvents: SponsorshipEvent[];
  /** Events that decoded but are missing required fields (`partial`). */
  partialEvents: SponsorshipEvent[];
  /** Events that could not be decoded at all. */
  unparsedEvents: ContractEventRaw[];
  /** Whether the caller should retry to obtain a complete picture. */
  retryable: boolean;
  /** Human-readable reason when `retryable` is true. */
  retryReason?: string;
}

function readString(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function readAmount(
  payload: Record<string, unknown>,
  ...keys: string[]
): bigint | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "bigint") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return BigInt(Math.trunc(value));
    }
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
      return BigInt(value);
    }
  }
  return undefined;
}

function isSponsorshipEventType(type: string): type is SponsorshipEventType {
  return (SPONSORSHIP_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Decodes raw Soroban contract events into sponsorship events used by the
 * sponsor portfolio reconciliation. Unlike {@link consumeContractEvents},
 * this surfaces partial and unreconciled states explicitly so operators can
 * distinguish "no data" from "data we could not fully decode".
 *
 * Events that fail to decode are reported in `unparsedEvents`; if any exist
 * the result is marked `retryable` so callers can re-fetch from the RPC
 * (e.g. transient RPC errors or lagging ledgers) before reconciling.
 *
 * @param events - Raw contract events from the RPC.
 * @returns Sponsorship consumption result with explicit failure states.
 *
 * @example
 * ```typescript
 * import { consumeSponsorshipEvents } from "@fundable/sdk";
 *
 * const rawEvents = await server.getEvents({ contractIds: [contractId] });
 * const result = consumeSponsorshipEvents(rawEvents);
 *
 * if (result.retryable) {
 *   console.warn("Retry event fetch:", result.retryReason);
 * }
 * for (const event of result.sponsorshipEvents) {
 *   console.log(event.type, event.amount, event.txHash, event.eventIndex);
 * }
 * ```
 */
export function consumeSponsorshipEvents(
  events: readonly ContractEventRaw[] | undefined,
): SponsorshipEventConsumptionResult {
  const rawList = Array.isArray(events) ? events : [];

  const sponsorshipEvents: SponsorshipEvent[] = [];
  const partialEvents: SponsorshipEvent[] = [];
  const unparsedEvents: ContractEventRaw[] = [];

  for (const event of rawList) {
    const parsed = parsePaymentStreamContractEvent(event);
    if (!parsed) {
      unparsedEvents.push(event);
      continue;
    }
    if (!isSponsorshipEventType(parsed.type)) {
      // Not a sponsorship event; ignore for portfolio reconciliation.
      continue;
    }

    const payload = (parsed.payload ?? {}) as Record<string, unknown>;
    const sponsorshipEvent: SponsorshipEvent = {
      type: parsed.type,
      contractId: parsed.contractId,
      ledger: parsed.ledger,
      txHash: parsed.txHash,
      eventIndex: parsed.eventIndex,
      campaignId: readString(payload, "campaign_id", "campaignId"),
      sponsor: readString(payload, "sponsor", "sponsor_address"),
      amount: readAmount(payload, "amount", "value"),
      payload,
    };

    // A sponsorship event is partial when it lacks the fields required to
    // reconcile value against authoritative records.
    const isPartial =
      sponsorshipEvent.amount === undefined ||
      sponsorshipEvent.campaignId === undefined;

    if (isPartial) {
      partialEvents.push(sponsorshipEvent);
    } else {
      sponsorshipEvents.push(sponsorshipEvent);
    }
  }

  const retryable = unparsedEvents.length > 0;
  return {
    totalRetrieved: rawList.length,
    sponsorshipEvents,
    partialEvents,
    unparsedEvents,
    retryable,
    retryReason: retryable
      ? `${unparsedEvents.length} event(s) could not be decoded; retry the fetch before reconciling.`
      : undefined,
  };
}

/**
 * Classifies a decoded sponsorship event against a set of authoritative
 * source references (e.g. `txHash:eventIndex` keys already reconciled).
 * Returns `reconciled` when the reference is present, otherwise
 * `unreconciled`.
 *
 * @param event - Decoded sponsorship event.
 * @param reconciledRefs - Set of `txHash:eventIndex` references already matched.
 * @returns Reconciliation status for the event.
 */
export function classifySponsorshipEvent(
  event: SponsorshipEvent,
  reconciledRefs: ReadonlySet<string>,
): SponsorshipReconciliationStatus {
  if (event.amount === undefined || event.campaignId === undefined) {
    return "partial";
  }
  return reconciledRefs.has(`${event.txHash}:${event.eventIndex}`)
    ? "reconciled"
    : "unreconciled";
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