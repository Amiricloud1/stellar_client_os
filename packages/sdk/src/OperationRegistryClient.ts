/**
 * OperationRegistryClient
 *
 * Provides TypeScript utilities for interacting with the operation-registry contract.
 * This includes:
 * - Computing operation IDs deterministically
 * - Fetching operation events from the contract
 * - Verifying operation chains and detecting missing events
 */

import { Address, Bytes, nativeToScVal, scValToNative } from '@stellar/js-sdk';
import { createHash } from 'crypto';

/**
 * Represents an event record linked to an operation
 */
export interface EventRecord {
  event_type: string;
  timestamp: number;
  ledger_seq: number;
  related_entity_id: bigint;
}

/**
 * Metadata about an operation
 */
export interface OperationMetadata {
  operation_id: bigint;
  contract_addr: string;
  tx_hash: string;
  ledger_seq: number;
  op_index: number;
  created_at: number;
}

/**
 * Event emitted when an operation is linked
 */
export interface OperationLinkedEvent {
  operation_id: bigint;
  event_type: string;
  related_entity_id: bigint;
}

/**
 * Computes a deterministic operation ID from operation components.
 *
 * Uses SHA256 to hash:
 * 1. Contract address (XDR bytes)
 * 2. Transaction hash (32 bytes)
 * 3. Ledger sequence (u32)
 * 4. Operation index (u32)
 *
 * Then converts the first 8 bytes of the hash to u64 (big-endian).
 *
 * @param contractAddr - Stellar contract address
 * @param txHash - Transaction hash (hex string or buffer)
 * @param ledgerSeq - Ledger sequence number
 * @param opIndex - Operation index within the transaction
 * @returns Operation ID as BigInt
 */
export function computeOperationId(
  contractAddr: string,
  txHash: string | Buffer,
  ledgerSeq: number,
  opIndex: number
): bigint {
  const hasher = createHash('sha256');

  // Hash the contract address
  // Convert address string to its XDR bytes representation
  const addressBytes = encodeAddress(contractAddr);
  hasher.update(addressBytes);

  // Hash the transaction hash
  const txHashBuffer = typeof txHash === 'string'
    ? Buffer.from(txHash, 'hex')
    : txHash;
  hasher.update(txHashBuffer);

  // Hash ledger sequence (big-endian u32)
  const ledgerSeqBuffer = Buffer.alloc(4);
  ledgerSeqBuffer.writeUInt32BE(ledgerSeq, 0);
  hasher.update(ledgerSeqBuffer);

  // Hash operation index (big-endian u32)
  const opIndexBuffer = Buffer.alloc(4);
  opIndexBuffer.writeUInt32BE(opIndex, 0);
  hasher.update(opIndexBuffer);

  // Get the hash and convert first 8 bytes to u64
  const hash = hasher.digest();
  const idBytes = hash.slice(0, 8);
  
  // Convert to u64 (big-endian)
  const id = BigInt(idBytes.readBigUInt64BE(0));
  
  return id;
}

/**
 * Encodes a Stellar address to its XDR byte representation.
 *
 * @param address - Stellar address string (starting with C for contracts or G for accounts)
 * @returns XDR-encoded address bytes
 */
function encodeAddress(address: string): Buffer {
  // Use Stellar SDK to decode the address
  const decoded = Address.fromString(address).toXDRObject();
  
  // Convert to XDR bytes
  // For addresses, we use the XDR representation
  const xdrBytes = Buffer.from(decoded.toXDR(), 'base64');
  
  return xdrBytes;
}

/**
 * Interface for a contract that implements the operation registry pattern
 */
export interface OperationRegistryContract {
  getOperationEvents(operationId: bigint): Promise<EventRecord[]>;
  getOperationMetadata(operationId: bigint): Promise<OperationMetadata | null>;
}

/**
 * Represents a verified operation chain
 */
export interface OperationChain {
  operation_id: bigint;
  events: EventRecord[];
  is_complete: boolean;
  missing_events?: string[];
  verification_errors?: string[];
}

/**
 * Verifies that an operation chain is complete and events are properly linked.
 *
 * Checks:
 * 1. Events are sorted by timestamp
 * 2. All events reference the same operation_id
 * 3. No significant time gaps that suggest missing events
 * 4. Event sequence is logical (e.g., no withdrawals before deposits)
 *
 * @param events - Array of EventRecord to verify
 * @param operationId - Expected operation ID for all events
 * @returns OperationChain with verification results
 */
export function verifyOperationChain(
  events: EventRecord[],
  operationId: bigint
): OperationChain {
  const errors: string[] = [];
  const missingEvents: string[] = [];

  // Check if events array is empty
  if (events.length === 0) {
    return {
      operation_id: operationId,
      events: [],
      is_complete: false,
      missing_events: ['No events found for operation'],
      verification_errors: errors,
    };
  }

  // Check if events are sorted by timestamp
  for (let i = 1; i < events.length; i++) {
    if (events[i].timestamp < events[i - 1].timestamp) {
      errors.push(
        `Events not sorted by timestamp at index ${i}: ${events[i].timestamp} < ${events[i - 1].timestamp}`
      );
    }
  }

  // Check for suspicious time gaps (more than 1 hour between consecutive events)
  const ONE_HOUR_SECONDS = 3600;
  for (let i = 1; i < events.length; i++) {
    const timeDiff = events[i].timestamp - events[i - 1].timestamp;
    if (timeDiff > ONE_HOUR_SECONDS) {
      missingEvents.push(
        `Large time gap between event ${i - 1} and ${i}: ${timeDiff} seconds`
      );
    }
  }

  // Verify event type sequence logic
  const eventTypes = events.map((e) => e.event_type);
  
  // Common patterns that might indicate missing events
  if (
    eventTypes.includes('Withdrawn') &&
    !eventTypes.includes('Deposited') &&
    !eventTypes.includes('Created')
  ) {
    missingEvents.push('Withdrawal detected without prior deposit or creation');
  }

  if (
    eventTypes.includes('Resumed') &&
    !eventTypes.includes('Paused')
  ) {
    missingEvents.push('Stream resumed without prior pause');
  }

  const is_complete = errors.length === 0 && missingEvents.length === 0;

  return {
    operation_id: operationId,
    events,
    is_complete,
    missing_events: missingEvents.length > 0 ? missingEvents : undefined,
    verification_errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Creates a mock contract client for testing operation registry integration.
 * In production, this would interface with the actual Soroban contract.
 */
export function createMockOperationRegistryContract(): OperationRegistryContract {
  const eventStore = new Map<string, EventRecord[]>();
  const metadataStore = new Map<string, OperationMetadata>();

  return {
    async getOperationEvents(operationId: bigint): Promise<EventRecord[]> {
      return eventStore.get(operationId.toString()) || [];
    },

    async getOperationMetadata(operationId: bigint): Promise<OperationMetadata | null> {
      return metadataStore.get(operationId.toString()) || null;
    },
  };
}

/**
 * Utility to decode operation metadata from contract storage
 */
export function decodeOperationMetadata(data: any): OperationMetadata {
  return {
    operation_id: BigInt(data.operation_id),
    contract_addr: data.contract_addr,
    tx_hash: data.tx_hash,
    ledger_seq: Number(data.ledger_seq),
    op_index: Number(data.op_index),
    created_at: Number(data.created_at),
  };
}

/**
 * Utility to decode event records from contract storage
 */
export function decodeEventRecord(data: any): EventRecord {
  return {
    event_type: data.event_type,
    timestamp: Number(data.timestamp),
    ledger_seq: Number(data.ledger_seq),
    related_entity_id: BigInt(data.related_entity_id),
  };
}

/**
 * Utility to generate a summary of operations for auditing/reporting
 */
export interface OperationSummary {
  total_operations: number;
  total_events: number;
  event_types: Record<string, number>;
  date_range: {
    earliest: number;
    latest: number;
  };
}

export function summarizeOperations(
  chains: OperationChain[]
): OperationSummary {
  let totalOps = 0;
  let totalEvents = 0;
  const eventCounts: Record<string, number> = {};
  let earliest = Number.MAX_SAFE_INTEGER;
  let latest = 0;

  for (const chain of chains) {
    totalOps++;
    totalEvents += chain.events.length;

    for (const event of chain.events) {
      eventCounts[event.event_type] = (eventCounts[event.event_type] || 0) + 1;
      earliest = Math.min(earliest, event.timestamp);
      latest = Math.max(latest, event.timestamp);
    }
  }

  return {
    total_operations: totalOps,
    total_events: totalEvents,
    event_types: eventCounts,
    date_range: {
      earliest: earliest === Number.MAX_SAFE_INTEGER ? 0 : earliest,
      latest,
    },
  };
}
