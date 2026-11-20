import { Dispatch, SetStateAction } from "react";
import { ColumnDef } from "@tanstack/react-table";

export type DistributionStatus = "completed" | "failed" | "pending";
export type DistributionType = "equal" | "weighted";

export interface DistributionAttributes {
    id: string;
    user_address: string;
    token_address: string;
    token_symbol: string;
    token_decimals: number;
    total_amount: string;
    fee_amount: string;
    transaction_hash?: string | null;
    total_recipients: number;
    status: DistributionStatus;
    distribution_type: DistributionType;
    network: "mainnet" | "testnet";
    created_at: Date | string;
}

/**
 * Indicates where a history entry originated when rendered in the audit timeline.
 *
 * - `live`: sourced directly from the active (non-compacted) event store.
 * - `archive`: sourced from a compacted/archived event envelope.
 * - `reconstructed`: rebuilt from an archived envelope's payload during
 *   reconstruction (e.g. after a compaction migration or recovery path).
 */
export type AuditHistorySource = "live" | "archive" | "reconstructed";

/**
 * Retention classification applied to an archived event envelope.
 * Mirrors the backend retention policy so operators can reason about
 * which records are still queryable and which are pending purge.
 */
export type AuditRetentionClass =
    | "standard"
    | "extended"
    | "compliance"
    | "transient";

/**
 * Linkage metadata attached to history entries that were compacted into an
 * archive envelope. Optional on `IHistoryData` so existing consumers that
 * only read live data continue to work unchanged.
 */
export interface AuditEnvelopeLinkage {
    /** Identifier of the archive envelope that contains this event. */
    envelopeId: string;
    /** Content hash of the original payload, used to verify reconstruction. */
    payloadHash: string;
    /** Retention class governing how long the envelope is queryable. */
    retentionClass: AuditRetentionClass;
}

/**
 * Describes the archive range a compacted history page was drawn from.
 * Used by the timeline and filter panel to surface which window of
 * history is being viewed and whether it is complete.
 */
export interface AuditArchiveRange {
    /** Inclusive lower bound (ISO timestamp) of the archived range. */
    from: string;
    /** Exclusive upper bound (ISO timestamp) of the archived range. */
    to: string;
    /** Number of events compacted into the range. */
    eventCount: number;
    /** Whether the range has been fully reconstructed and verified. */
    reconstructed: boolean;
    /** Optional reason the range is incomplete or partially available. */
    incompleteReason?: string;
}

export interface IHistoryData {
    id: string;
    type: string; // "Stream" | "Distribution"
    date: string;
    amount: string;
    token: string;
    recipients: number;
    status: string;
    transaction_hash?: string;
    /** Origin of this entry; defaults to `live` when omitted. */
    source?: AuditHistorySource;
    /** Envelope linkage for compacted entries. */
    envelopeId?: string;
    payloadHash?: string;
    retentionClass?: AuditRetentionClass;
    /** Archive range metadata when this entry came from a compacted range. */
    archiveRange?: AuditArchiveRange;
}

export interface DataTableProps<TData, TValue> {
    columns: ColumnDef<TData, TValue>[];
    data: TData[];
    onStatusFilterChange: Dispatch<
        SetStateAction<DistributionStatus | "all">
    >;
    onTypeFilterChange: Dispatch<
        SetStateAction<DistributionType | "all">
    >;
    statusFilter: DistributionStatus | "all";
    typeFilter: DistributionType | "all";
    totalCount?: number;
    page: number;
    limit: number;
}

export type distributionFilterType = "status" | "type";

export type distributionFilterValueType =
    | DistributionStatus
    | DistributionType
    | "all";

/**
 * Filter state for the audit history timeline, including the ability to
 * scope results to a particular history source (live vs. archived).
 */
export interface AuditHistoryFilter {
    source: AuditHistorySource | "all";
    retentionClass: AuditRetentionClass | "all";
    /** Optional archive range to restrict results to. */
    archiveRange?: Pick<AuditArchiveRange, "from" | "to">;
}