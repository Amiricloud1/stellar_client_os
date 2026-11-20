/**
 * One-time charitable campaign donation models (issue #1001).
 *
 * A donation is a flexible contribution that is deliberately *not* tied to
 * specific trees: the whole amount is placed at the campaign creator's
 * discretion so it can be spent on project costs. Donations reuse the campaign
 * contribution ledger so a campaign's raised total and funding milestones stay
 * in sync with every other kind of contribution.
 */

export type DonationToken = "XLM" | "USDC";

/** A donation is only ever created once the ledger entry has been written. */
export type DonationStatus = "CONFIRMED" | "FAILED";

/**
 * Transaction lifecycle (issue #239).
 *
 * A donation moves through a sequence of explicit states so the UI can show a
 * confirmation timeline and recover after a page reload:
 *
 *   wallet_approval -> submitted -> ledger_confirmed -> settled
 *
 * Any non-terminal state may instead transition to `failed` (the wallet or
 * network rejected the transaction) or `timed_out` (no confirmation was
 * observed before the deadline). `ledger_confirmed`, `settled`, `failed` and
 * `timed_out` are terminal for a given attempt; a retry starts a new attempt
 * that is appended to the same timeline.
 *
 * Persistence contract: the timeline is stored client-side keyed by the
 * transaction hash (see `TransactionTimeline`). It must be written *before*
 * the wallet is asked to sign so a reload mid-approval can resume, and it is
 * only discarded once the donation is durably recorded server-side. Recovery
 * metadata (`attempt`, `lastUpdatedAt`, `recoverable`, `resumeFrom`) lets the
 * UI rehydrate the correct step after a reload without re-submitting.
 */
export type TransactionLifecycleState =
  | "wallet_approval"
  | "submitted"
  | "ledger_confirmed"
  | "settled"
  | "failed"
  | "timed_out";

export const TRANSACTION_LIFECYCLE_STATES: readonly TransactionLifecycleState[] = [
  "wallet_approval",
  "submitted",
  "ledger_confirmed",
  "settled",
  "failed",
  "timed_out",
];

/** States from which no further transition is expected for the attempt. */
export const TERMINAL_TRANSACTION_STATES: readonly TransactionLifecycleState[] = [
  "settled",
  "failed",
  "timed_out",
];

/** Human-readable labels for the confirmation timeline. */
export const TRANSACTION_STATE_LABELS: Record<TransactionLifecycleState, string> = {
  wallet_approval: "Awaiting wallet approval",
  submitted: "Submitted to network",
  ledger_confirmed: "Confirmed on ledger",
  settled: "Settled",
  failed: "Failed",
  timed_out: "Timed out",
};

export function isTransactionLifecycleState(value: unknown): value is TransactionLifecycleState {
  return (
    typeof value === "string" &&
    (TRANSACTION_LIFECYCLE_STATES as readonly string[]).includes(value)
  );
}

export function isTerminalTransactionState(state: TransactionLifecycleState): boolean {
  return TERMINAL_TRANSACTION_STATES.includes(state);
}

/** A single state transition recorded on a transaction timeline. */
export interface TransactionLifecycleEvent {
  state: TransactionLifecycleState;
  /** Epoch milliseconds at which the transition was observed. */
  at: number;
  /** Attempt number (1-based) this event belongs to; retries increment it. */
  attempt: number;
  /** Optional human-readable detail, e.g. an error message for `failed`. */
  detail?: string;
  /** Ledger sequence, present once the transaction is confirmed on-chain. */
  ledger?: number;
}

/** Recovery metadata persisted alongside a timeline. */
export interface TransactionTimelineRecovery {
  /** Whether the UI can resume this transaction after a reload. */
  recoverable: boolean;
  /** State the UI should resume from; `null` once the timeline is terminal. */
  resumeFrom: TransactionLifecycleState | null;
  /** Epoch milliseconds after which an in-flight attempt is considered timed out. */
  deadlineAt?: number;
  /** Number of attempts made so far (1-based). */
  attempt: number;
  /** Epoch milliseconds of the last persisted update. */
  lastUpdatedAt: number;
}

/**
 * Persisted confirmation timeline for a single transaction, keyed by hash.
 * The hash may be provisional (client-generated) until the network returns the
 * real one; `txHash` is updated in place when that happens.
 */
export interface TransactionTimeline {
  txHash: string;
  campaignId: string;
  donationId?: string;
  /** Current state — always the state of the last event. */
  state: TransactionLifecycleState;
  events: TransactionLifecycleEvent[];
  recovery: TransactionTimelineRecovery;
  createdAt: number;
  updatedAt: number;
}

/** Storage key prefix for persisted timelines. */
export const TRANSACTION_TIMELINE_STORAGE_PREFIX = "treefund:tx-timeline:";

export function transactionTimelineStorageKey(txHash: string): string {
  return `${TRANSACTION_TIMELINE_STORAGE_PREFIX}${txHash}`;
}

/**
 * Create a fresh timeline in `wallet_approval`. Call this *before* prompting
 * the wallet so a reload mid-approval can recover.
 */
export function createTransactionTimeline(params: {
  txHash: string;
  campaignId: string;
  donationId?: string;
  now: number;
  deadlineAt?: number;
}): TransactionTimeline {
  const event: TransactionLifecycleEvent = {
    state: "wallet_approval",
    at: params.now,
    attempt: 1,
  };
  return {
    txHash: params.txHash,
    campaignId: params.campaignId,
    donationId: params.donationId,
    state: "wallet_approval",
    events: [event],
    recovery: {
      recoverable: true,
      resumeFrom: "wallet_approval",
      deadlineAt: params.deadlineAt,
      attempt: 1,
      lastUpdatedAt: params.now,
    },
    createdAt: params.now,
    updatedAt: params.now,
  };
}

/**
 * Append a transition to a timeline, returning a new immutable timeline.
 * Throws when transitioning out of a terminal state — callers must start a new
 * attempt (via `retryTransactionTimeline`) instead.
 */
export function appendTransactionEvent(
  timeline: TransactionTimeline,
  event: Omit<TransactionLifecycleEvent, "attempt"> & { attempt?: number },
): TransactionTimeline {
  if (isTerminalTransactionState(timeline.state)) {
    throw new Error(
      `Cannot transition from terminal state "${timeline.state}" to "${event.state}".`,
    );
  }
  const attempt = event.attempt ?? timeline.recovery.attempt;
  const nextEvent: TransactionLifecycleEvent = { ...event, attempt };
  const terminal = isTerminalTransactionState(event.state);
  return {
    ...timeline,
    state: event.state,
    events: [...timeline.events, nextEvent],
    recovery: {
      ...timeline.recovery,
      recoverable: !terminal,
      resumeFrom: terminal ? null : event.state,
      attempt,
      lastUpdatedAt: event.at,
    },
    updatedAt: event.at,
  };
}

/**
 * Start a new attempt after a failure or timeout, preserving prior events so
 * the full history remains visible. Returns a new timeline in
 * `wallet_approval` for the next attempt.
 */
export function retryTransactionTimeline(
  timeline: TransactionTimeline,
  now: number,
  deadlineAt?: number,
): TransactionTimeline {
  const attempt = timeline.recovery.attempt + 1;
  const event: TransactionLifecycleEvent = { state: "wallet_approval", at: now, attempt };
  return {
    ...timeline,
    state: "wallet_approval",
    events: [...timeline.events, event],
    recovery: {
      recoverable: true,
      resumeFrom: "wallet_approval",
      deadlineAt,
      attempt,
      lastUpdatedAt: now,
    },
    updatedAt: now,
  };
}

/**
 * Rehydrate a timeline after a reload. Returns `null` when the stored value is
 * missing or malformed so callers can fall back to a fresh attempt.
 */
export function parseTransactionTimeline(raw: string | null | undefined): TransactionTimeline | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TransactionTimeline>;
    if (
      typeof parsed?.txHash !== "string" ||
      typeof parsed?.campaignId !== "string" ||
      !isTransactionLifecycleState(parsed?.state) ||
      !Array.isArray(parsed?.events) ||
      typeof parsed?.recovery !== "object" ||
      parsed.recovery === null
    ) {
      return null;
    }
    return parsed as TransactionTimeline;
  } catch {
    return null;
  }
}

/** How a donation's funds are allocated by the campaign. */
export type DonationAllocation = "CREATOR_DISCRETION";

export const DONATION_ALLOCATION: DonationAllocation = "CREATOR_DISCRETION";

export const DONATION_ALLOCATION_LABEL = "Creator's discretion";

export const DONATION_ALLOCATION_DESCRIPTION =
  "The full amount is released to the campaign creator to cover project costs. No tree is assigned to this donation.";

export const DONATION_TOKENS: readonly DonationToken[] = ["XLM", "USDC"];

/** Smallest one-time donation accepted (in whole tokens). */
export const MIN_DONATION_AMOUNT = "1";

/** Largest one-time donation accepted — guards against fat-finger entries. */
export const MAX_DONATION_AMOUNT = "1000000";

/** Longest optional donor message. */
export const MAX_DONATION_MESSAGE_LENGTH = 280;

/** Quick-pick amounts shown in the donation UI. */
export const DONATION_PRESET_AMOUNTS: readonly string[] = ["10", "25", "50", "100", "250"];

export interface CampaignDonation {
  id: string;
  campaignId: string;
  donorAddress: string;
  /** Normalised decimal amount, e.g. "25.5". */
  amount: string;
  token: DonationToken;
  allocation: DonationAllocation;
  message?: string;
  anonymous: boolean;
  status: DonationStatus;
  txHash?: string;
  /** Optional caller-supplied key used to make retries idempotent. */
  idempotencyKey?: string;
  createdAt: number;
  confirmedAt: number;
}

export interface DonationReceipt {
  receiptId: string;
  /** Human-readable reference shown to the donor, e.g. "DON-camp-101-A1B2C3". */
  reference: string;
  donationId: string;
  campaignId: string;
  campaignName: string;
  donorAddress: string;
  amount: string;
  token: DonationToken;
  allocation: DonationAllocation;
  allocationLabel: string;
  allocationDescription: string;
  status: DonationStatus;
  issuedAt: number;
}

export interface DonationSummary {
  campaignId: string;
  donationCount: number;
  /** Exact totals per token so XLM and USDC are never summed together. */
  totalsByToken: Record<DonationToken, string>;
  latestDonationAt?: number;
}

export function isDonationToken(value: unknown): value is DonationToken {
  return value === "XLM" || value === "USDC";
}

export function isDonationStatus(value: unknown): value is DonationStatus {
  return value === "CONFIRMED" || value === "FAILED";
}

const WHOLE_AMOUNT_PATTERN = /^\d+$/;

/**
 * Normalise a user-entered donation amount, or return `null` when it cannot be
 * parsed. Amounts are whole tokens so a donation maps 1:1 onto the campaign
 * contribution ledger (which stores whole display units).
 */
export function normalizeDonationAmount(value: string | number): string | null {
  const text = String(value ?? "").trim();
  if (!WHOLE_AMOUNT_PATTERN.test(text)) return null;
  return BigInt(text).toString();
}

/**
 * Validate a donation amount against the configured bounds.
 * Returns an error message, or `null` when the amount is acceptable.
 */
export function validateDonationAmount(amount: string | number): string | null {
  const normalized = normalizeDonationAmount(amount);
  if (normalized === null) return "Enter a whole-number donation amount.";

  const value = BigInt(normalized);
  if (value <= 0n) return "Enter a donation amount greater than zero.";
  if (value < BigInt(MIN_DONATION_AMOUNT)) {
    return `The minimum donation is ${MIN_DONATION_AMOUNT} tokens.`;
  }
  if (value > BigInt(MAX_DONATION_AMOUNT)) {
    return `The maximum donation is ${MAX_DONATION_AMOUNT} tokens.`;
  }
  return null;
}

/** Shorten a Stellar address for display: "GABC…WXYZ". */
export function maskDonorAddress(address: string): string {
  const trimmed = (address ?? "").trim();
  if (trimmed.length <= 10) return trimmed;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

/** Deterministic receipt reference for a donation. */
export function donationReceiptReference(campaignId: string, donationId: string): string {
  const campaignPart = (campaignId ?? "").trim() || "campaign";
  const suffix = (donationId ?? "").replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase() || "000000";
  return `DON-${campaignPart}-${suffix}`;
}
