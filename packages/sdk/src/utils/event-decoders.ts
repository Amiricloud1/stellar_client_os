/**
 * Multi-Contract Family Event Decoders.
 *
 * Provides strongly typed decoders for events emitted across all Fundable
 * contract families (PaymentStream, Distributor, Timelock, CampaignFunding,
 * CampaignDiversity, SponsorCrowdfunding), with safe fallbacks for
 * unknown or future topics.
 */

export type ContractFamily =
  | 'payment-stream'
  | 'distributor'
  | 'timelock'
  | 'campaign-funding'
  | 'campaign-diversity'
  | 'sponsor-crowdfunding'
  | 'unknown';

export interface BaseDecodedEvent<TFamily extends ContractFamily, TType extends string, TPayload> {
  family: TFamily;
  type: TType;
  contractId?: string;
  rawTopic: unknown[];
  payload: TPayload;
}

// ---------------------------------------------------------------------------
// Event Payload Types
// ---------------------------------------------------------------------------

export type PaymentStreamDecodedEvent =
  | BaseDecodedEvent<'payment-stream', 'FeeCollected', { streamId: bigint; recipient: string; amount: bigint; timestamp?: number }>
  | BaseDecodedEvent<'payment-stream', 'StreamDeposit', { streamId: bigint; sender: string; amount: bigint }>
  | BaseDecodedEvent<'payment-stream', 'StreamPaused', { streamId: bigint; pausedBy: string }>
  | BaseDecodedEvent<'payment-stream', 'StreamResumed', { streamId: bigint; resumedBy: string }>
  | BaseDecodedEvent<'payment-stream', 'DelegationGranted', { streamId: bigint; delegate: string; permissions?: number }>
  | BaseDecodedEvent<'payment-stream', 'DelegationRevoked', { streamId: bigint; delegate: string }>;

export type DistributorDecodedEvent =
  | BaseDecodedEvent<'distributor', 'DistributeBatch', { token: string; sender: string; recipientCount: number; totalAmount: bigint }>
  | BaseDecodedEvent<'distributor', 'DistributeEqual', { token: string; sender: string; recipientCount: number; totalAmount: bigint }>;

export type TimelockDecodedEvent =
  | BaseDecodedEvent<'timelock', 'ActionProposed', { admin: string; actionHash: string; target?: string; description: string }>
  | BaseDecodedEvent<'timelock', 'ActionExecuted', { admin: string; actionHash: string; target?: string }>
  | BaseDecodedEvent<'timelock', 'ActionCancelled', { admin: string; actionHash: string }>;

export type CampaignFundingDecodedEvent =
  | BaseDecodedEvent<'campaign-funding', 'CampaignCreated', { campaignId: bigint; owner: string; goal?: bigint }>
  | BaseDecodedEvent<'campaign-funding', 'DonationReceived', { campaignId: bigint; donor: string; amount: bigint }>
  | BaseDecodedEvent<'campaign-funding', 'CampaignFinalized', { campaignId: bigint; success: boolean }>
  | BaseDecodedEvent<'campaign-funding', 'CampaignMatched', { campaignId: bigint; sponsor: string; amount: bigint }>;

export type CampaignDiversityDecodedEvent =
  | BaseDecodedEvent<'campaign-diversity', 'DiversityScored', { campaignId: bigint; score: number }>;

export type SponsorCrowdfundingDecodedEvent =
  | BaseDecodedEvent<'sponsor-crowdfunding', 'Pledged', { campaignId: bigint; sponsor: string; amount: bigint }>
  | BaseDecodedEvent<'sponsor-crowdfunding', 'Settled', { campaignId: bigint; totalRaised: bigint }>
  | BaseDecodedEvent<'sponsor-crowdfunding', 'SponsorshipSettled', { campaignId: bigint; sponsor: string; committed: bigint; matched: bigint; settled: bigint }>;

export type UnknownDecodedEvent = BaseDecodedEvent<'unknown', 'Unknown', { rawValue: unknown; reason: string }>;

// ---------------------------------------------------------------------------
// Canonical Domain Mapping Layer
// ---------------------------------------------------------------------------

/**
 * Canonical domain projections keyed by contract family. Each projection is a
 * normalized, version-independent view of an event payload.
 */
export interface CanonicalDomainProjection {
  family: ContractFamily;
  type: string;
  schemaVersion: number;
  fields: Record<string, unknown>;
}

/**
 * Wrapper retained for events whose schema version is unknown or unsupported.
 * The raw payload is preserved verbatim so downstream consumers can still
 * inspect, persist, or replay it rather than silently dropping the event.
 */
export interface RetainedUnknownEvent {
  status: 'retained-unknown';
  family: ContractFamily;
  type: string;
  schemaVersion: number | null;
  contractId?: string;
  rawTopic: unknown[];
  rawValue: unknown;
  reason: string;
  retainedAt: number;
}

export type CanonicalMappingResult =
  | { status: 'mapped'; projection: CanonicalDomainProjection }
  | { status: 'retained-unknown'; event: RetainedUnknownEvent };

/**
 * A single registry entry: maps a raw payload for a specific event type and
 * schema version into a canonical domain projection.
 */
export interface CanonicalEventMappingEntry {
  family: ContractFamily;
  type: string;
  schemaVersion: number;
  project: (rawValue: unknown) => Record<string, unknown> | null;
}

/**
 * Registry keyed by `${type}@${schemaVersion}`.
 */
export class CanonicalEventMappingRegistry {
  private readonly entries = new Map<string, CanonicalEventMappingEntry>();
  private readonly registrationToken: symbol | undefined;

  /**
   * @param registrationToken Optional authorization token. When provided,
   *   `register` requires the same token instance to mutate the registry.
   */
  constructor(registrationToken?: symbol) {
    this.registrationToken = registrationToken;
  }

  private key(type: string, schemaVersion: number): string {
    return `${type}@${schemaVersion}`;
  }

  register(entry: CanonicalEventMappingEntry, token?: symbol): void {
    if (this.registrationToken !== undefined && token !== this.registrationToken) {
      throw new Error(
        `Unauthorized canonical mapping registration for ${entry.type}@${entry.schemaVersion}`
      );
    }
    if (!entry.type) {
      throw new Error('Canonical mapping entry requires a non-empty event type');
    }
    if (!Number.isInteger(entry.schemaVersion) || entry.schemaVersion < 0) {
      throw new Error(`Invalid schema version for ${entry.type}: ${entry.schemaVersion}`);
    }
    this.entries.set(this.key(entry.type, entry.schemaVersion), entry);
  }

  has(type: string, schemaVersion: number): boolean {
    return this.entries.has(this.key(type, schemaVersion));
  }

  get(type: string, schemaVersion: number): CanonicalEventMappingEntry | undefined {
    return this.entries.get(this.key(type, schemaVersion));
  }

  /**
   * Resolve a raw event to a canonical projection, or retain it as unknown.
   */
  resolve(
    type: string,
    schemaVersion: number | null,
    rawValue: unknown,
    context: { contractId?: string; rawTopic: unknown[] }
  ): CanonicalMappingResult {
    const retained = (reason: string): CanonicalMappingResult => ({
      status: 'retained-unknown',
      event: {
        status: 'retained-unknown',
        family: 'unknown',
        type,
        schemaVersion,
        contractId: context.contractId,
        rawTopic: context.rawTopic,
        rawValue,
        reason,
        retainedAt: Date.now(),
      },
    });

    if (schemaVersion === null || !Number.isInteger(schemaVersion)) {
      return retained(`Unknown schema version for event type: ${type || 'empty'}`);
    }

    const entry = this.get(type, schemaVersion);
    if (!entry) {
      return retained(`Unsupported schema version ${schemaVersion} for event type: ${type || 'empty'}`);
    }

    let fields: Record<string, unknown> | null;
    try {
      fields = entry.project(rawValue);
    } catch (err) {
      return retained(`Mapping error for ${type}@${schemaVersion}: ${String(err)}`);
    }

    if (fields === null) {
      return retained(`Malformed payload for ${type}@${schemaVersion}`);
    }

    return {
      status: 'mapped',
      projection: {
        family: entry.family,
        type: entry.type,
        schemaVersion: entry.schemaVersion,
        fields,
      },
    };
  }
}

/**
 * Default registry populated with the canonical mappings for supported
 * contract-event versions. Registration is authorized by the module-private
 * token so external callers cannot silently override canonical mappings.
 */
const CANONICAL_REGISTRATION_TOKEN = Symbol('canonical-event-mapping-registration');

export const canonicalEventMappings = new CanonicalEventMappingRegistry(
  CANONICAL_REGISTRATION_TOKEN
);

function registerCanonical(entry: CanonicalEventMappingEntry): void {
  canonicalEventMappings.register(entry, CANONICAL_REGISTRATION_TOKEN);
}

registerCanonical({
  family: 'payment-stream',
  type: 'FeeCollected',
  schemaVersion: 1,
  project: (v) => {
    const o = (v as any) || {};
    const streamId = toBigInt(o.stream_id ?? o.streamId);
    const recipient = toString(o.recipient);
    const amount = toBigInt(o.amount);
    if (streamId === null || !recipient || amount === null) return null;
    return { streamId, recipient, amount, timestamp: o.timestamp ? Number(o.timestamp) : undefined };
  },
});

registerCanonical({
  family: 'payment-stream',
  type: 'StreamDeposit',
  schemaVersion: 1,
  project: (v) => {
    const o = (v as any) || {};
    const streamId = toBigInt(o.stream_id ?? o.streamId);
    const sender = toString(o.sender);
    const amount = toBigInt(o.amount);
    if (streamId === null || !sender || amount === null) return null;
    return { streamId, sender, amount };
  },
});

registerCanonical({
  family: 'distributor',
  type: 'DistributeBatch',
  schemaVersion: 1,
  project: (v) => {
    const o = (v as any) || {};
    const token = toString(o.token);
    const sender = toString(o.sender);
    const recipientCount = Number(o.recipient_count ?? o.recipientCount);
    const totalAmount = toBigInt(o.total_amount ?? o.totalAmount);
    if (!token || !sender || isNaN(recipientCount) || totalAmount === null) return null;
    return { token, sender, recipientCount, totalAmount };
  },
});

registerCanonical({
  family: 'timelock',
  type: 'ActionProposed',
  schemaVersion: 1,
  project: (v) => {
    const o = (v as any) || {};
    const admin = toString(o.admin);
    const actionHash = toString(o.action_hash ?? o.actionHash);
    const description = toString(o.description);
    if (!admin || !actionHash || !description) return null;
    return {
      admin,
      actionHash,
      target: o.target ? toString(o.target) ?? undefined : undefined,
      description,
    };
  },
});

registerCanonical({
  family: 'campaign-funding',
  type: 'CampaignCreated',
  schemaVersion: 1,
  project: (v) => {
    const o = (v as any) || {};
    const campaignId = toBigInt(o.id ?? o.campaign_id ?? o.campaignId);
    const owner = toString(o.owner);
    if (campaignId === null || !owner) return null;
    return { campaignId, owner, goal: o.goal ? toBigInt(o.goal) ?? undefined : undefined };
  },
});

registerCanonical({
  family: 'sponsor-crowdfunding',
  type: 'Pledged',
  schemaVersion: 1,
  project: (v) => {
    const o = (v as any) || {};
    const campaignId = toBigInt(o.campaign_id ?? o.campaignId);
    const sponsor = toString(o.sponsor);
    const amount = toBigInt(o.amount);
    if (campaignId === null || !sponsor || amount === null) return null;
    return { campaignId, sponsor, amount };
  },
});

/**
 * Extract the schema version from a raw event, if present. Accepts either a
 * `schema_version`/`schemaVersion` field on the value or a `v`/`version` field.
 */
export function extractSchemaVersion(raw: RawEventInput): number | null {
  const val = raw.value;
  if (val && typeof val === 'object') {
    const o = val as any;
    const candidate = o.schema_version ?? o.schemaVersion ?? o.version ?? o.v;
    const n = Number(candidate);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return null;
}

/**
 * Resolve a raw event through the canonical mapping registry. This is the
 * authoritative boundary: supported versions yield a canonical projection,
 * unknown versions are retained (never dropped).
 */
export function resolveCanonicalEvent(raw: RawEventInput): CanonicalMappingResult {
  const contractId = raw.contractId ?? raw.contract_id;
  const topic = Array.isArray(raw.topic) ? raw.topic : [];
  const type = getTopicName(topic);
  const schemaVersion = extractSchemaVersion(raw);
  return canonicalEventMappings.resolve(type, schemaVersion, raw.value, {
    contractId,
    rawTopic: topic,
  });
}

export type DecodedContractEvent =
  | PaymentStreamDecodedEvent
  | DistributorDecodedEvent
  | TimelockDecodedEvent
  | CampaignFundingDecodedEvent
  | CampaignDiversityDecodedEvent
  | SponsorCrowdfundingDecodedEvent
  | UnknownDecodedEvent;

export interface RawEventInput {
  contract_id?: string;
  contractId?: string;
  topic: unknown[];
  value: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBigInt(val: unknown): bigint | null {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number' && Number.isSafeInteger(val)) return BigInt(val);
  if (typeof val === 'string' && /^-?\d+$/.test(val)) return BigInt(val);
  return null;
}

function toString(val: unknown): string | null {
  if (typeof val === 'string') return val;
  if (val && typeof (val as any).toString === 'function') return (val as any).toString();
  return null;
}

function getTopicName(topic: unknown[]): string {
  if (!topic || topic.length === 0) return '';
  const first = topic[0];
  if (typeof first === 'string') return first;
  if (first && typeof (first as any).toString === 'function') return (first as any).toString();
  return '';
}

// ---------------------------------------------------------------------------
// Main Decoders
// ---------------------------------------------------------------------------

export function decodeContractEvent(raw: RawEventInput): DecodedContractEvent {
  const contractId = raw.contractId ?? raw.contract_id;
  const topic = Array.isArray(raw.topic) ? raw.topic : [];
  const topicName = getTopicName(topic);
  const val = raw.value;

  try {
    // 1. PaymentStream Family
    if (topicName === 'FeeCollected' || topicName === 'fee_collected') {
      const v = (val as any) || {};
      const streamId = toBigInt(v.stream_id ?? v.streamId);
      const recipient = toString(v.recipient);
      const amount = toBigInt(v.amount);
      if (streamId !== null && recipient && amount !== null) {
        return {
          family: 'payment-stream',
          type: 'FeeCollected',
          contractId,
          rawTopic: topic,
          payload: { streamId, recipient, amount, timestamp: v.timestamp ? Number(v.timestamp) : undefined },
        };
      }
    }

    if (topicName === 'StreamDeposit') {
      const v = (val as any) || {};
      const streamId = toBigInt(v.stream_id ?? v.streamId);
      const sender = toString(v.sender);
      const amount = toBigInt(v.amount);
      if (streamId !== null && sender && amount !== null) {
        return {
          family: 'payment-stream',
          type: 'StreamDeposit',
          contractId,
          rawTopic: topic,
          payload: { streamId, sender, amount },
        };
      }
    }

    if (topicName === 'StreamPaused') {
      const v = (val as any) || {};
      const streamId = toBigInt(v.stream_id ?? v.streamId);
      const pausedBy = toString(v.paused_by ?? v.pausedBy ?? v.admin);
      if (streamId !== null && pausedBy) {
        return {
          family: 'payment-stream',
          type: 'StreamPaused',
          contractId,
          rawTopic: topic,
          payload: { streamId, pausedBy },
        };
      }
    }

    if (topicName === 'StreamResumed') {
      const v = (val as any) || {};
      const streamId = toBigInt(v.stream_id ?? v.streamId);
      const resumedBy = toString(v.resumed_by ?? v.resumedBy ?? v.admin);
      if (streamId !== null && resumedBy) {
        return {
          family: 'payment-stream',
          type: 'StreamResumed',
          contractId,
          rawTopic: topic,
          payload: { streamId, resumedBy },
        };
      }
    }

    // 2. Distributor Family
    if (topicName === 'DistributeBatch' || topicName === 'DistributeEqual') {
      const isBatch = topicName === 'DistributeBatch';
      // Value can be tuple or record
      let token: string | null = null;
      let sender: string | null = null;
      let recipientCount: number | null = null;
      let totalAmount: bigint | null = null;

      if (Array.isArray(val)) {
        token = toString(val[0]);
        sender = toString(val[1]);
        recipientCount = Number(val[2]);
        totalAmount = toBigInt(val[3]);
      } else if (typeof val === 'object' && val !== null) {
        const v = val as any;
        token = toString(v.token);
        sender = toString(v.sender);
        recipientCount = Number(v.recipient_count ?? v.recipientCount);
        totalAmount = toBigInt(v.total_amount ?? v.totalAmount);
      }

      if (token && sender && recipientCount !== null && totalAmount !== null) {
        return {
          family: 'distributor',
          type: isBatch ? 'DistributeBatch' : 'DistributeEqual',
          contractId,
          rawTopic: topic,
          payload: { token, sender, recipientCount, totalAmount },
        };
      }
    }

    // 3. Timelock Family
    if (topicName === 'ActionProposed') {
      let admin: string | null = null;
      let actionHash: string | null = null;
      let target: string | undefined = undefined;
      let description: string | null = null;

      if (Array.isArray(val)) {
        admin = toString(val[0]);
        actionHash = toString(val[1]);
        target = val[2] ? toString(val[2]) ?? undefined : undefined;
        description = toString(val[3]);
      } else if (typeof val === 'object' && val !== null) {
        const v = val as any;
        admin = toString(v.admin);
        actionHash = toString(v.action_hash ?? v.actionHash);
        target = v.target ? toString(v.target) ?? undefined : undefined;
        description = toString(v.description);
      }

      if (admin && actionHash && description) {
        return {
          family: 'timelock',
          type: 'ActionProposed',
          contractId,
          rawTopic: topic,
          payload: { admin, actionHash, target, description },
        };
      }
    }

    if (topicName === 'ActionExecuted') {
      let admin: string | null = null;
      let actionHash: string | null = null;
      let target: string | undefined = undefined;

      if (Array.isArray(val)) {
        admin = toString(val[0]);
        actionHash = toString(val[1]);
        target = val[2] ? toString(val[2]) ?? undefined : undefined;
      } else if (typeof val === 'object' && val !== null) {
        const v = val as any;
        admin = toString(v.admin);
        actionHash = toString(v.action_hash ?? v.actionHash);
        target = v.target ? toString(v.target) ?? undefined : undefined;
      }

      if (admin && actionHash) {
        return {
          family: 'timelock',
          type: 'ActionExecuted',
          contractId,
          rawTopic: topic,
          payload: { admin, actionHash, target },
        };
      }
    }

    if (topicName === 'ActionCancelled') {
      let admin: string | null = null;
      let actionHash: string | null = null;

      if (Array.isArray(val)) {
        admin = toString(val[0]);
        actionHash = toString(val[1]);
      } else if (typeof val === 'object' && val !== null) {
        const v = val as any;
        admin = toString(v.admin);
        actionHash = toString(v.action_hash ?? v.actionHash);
      }

      if (admin && actionHash) {
        return {
          family: 'timelock',
          type: 'ActionCancelled',
          contractId,
          rawTopic: topic,
          payload: { admin, actionHash },
        };
      }
    }

    // 4. Campaign Funding Family
    if (topicName === 'campaign_created' || topicName === 'CampaignCreated') {
      const v = (val as any) || {};
      const campaignId = toBigInt(v.id ?? v.campaign_id ?? v.campaignId);
      const owner = toString(v.owner);
      if (campaignId !== null && owner) {
        return {
          family: 'campaign-funding',
          type: 'CampaignCreated',
          contractId,
          rawTopic: topic,
          payload: { campaignId, owner, goal: v.goal ? toBigInt(v.goal) ?? undefined : undefined },
        };
      }
    }

    if (topicName === 'campaign_matched' || topicName === 'CampaignMatched') {
      const v = (val as any) || {};
      const campaignId = toBigInt(v.campaign_id ?? v.campaignId);
      const sponsor = toString(v.sponsor);
      const amount = toBigInt(v.amount);
      if (campaignId !== null && sponsor && amount !== null) {
        return {
          family: 'campaign-funding',
          type: 'CampaignMatched',
          contractId,
          rawTopic: topic,
          payload: { campaignId, sponsor, amount },
        };
      }
    }

    // 5. Campaign Diversity Family
    if (topicName === 'diversity_scored' || topicName === 'DiversityScored') {
      const v = (val as any) || {};
      const campaignId = toBigInt(v.campaign_id ?? v.campaignId);
      const score = Number(v.score);
      if (campaignId !== null && !isNaN(score)) {
        return {
          family: 'campaign-diversity',
          type: 'DiversityScored',
          contractId,
          rawTopic: topic,
          payload: { campaignId, score },
        };
      }
    }

    // 6. Sponsor Crowdfunding Family
    if (topicName === 'sponsorship_settled' || topicName === 'SponsorshipSettled') {
      const v = (val as any) || {};
      const campaignId = toBigInt(v.campaign_id ?? v.campaignId);
      const sponsor = toString(v.sponsor);
      const committed = toBigInt(v.committed);
      const matched = toBigInt(v.matched);
      const settled = toBigInt(v.settled);
      if (
        campaignId !== null &&
        sponsor &&
        committed !== null &&
        matched !== null &&
        settled !== null
      ) {
        return {
          family: 'sponsor-crowdfunding',
          type: 'SponsorshipSettled',
          contractId,
          rawTopic: topic,
          payload: { campaignId, sponsor, committed, matched, settled },
        };
      }
    }

    if (topicName === 'pledge' || topicName === 'Pledged') {
      const v = (val as any) || {};
      const campaignId = toBigInt(v.campaign_id ?? v.campaignId);
      const sponsor = toString(v.sponsor);
      const amount = toBigInt(v.amount);
      if (campaignId !== null && sponsor && amount !== null) {
        return {
          family: 'sponsor-crowdfunding',
          type: 'Pledged',
          contractId,
          rawTopic: topic,
          payload: { campaignId, sponsor, amount },
        };
      }
    }

    if (topicName === 'settled' || topicName === 'Settled') {
      const v = (val as any) || {};
      const campaignId = toBigInt(v.campaign_id ?? v.campaignId);
      const totalRaised = toBigInt(v.total_raised ?? v.totalRaised);
      if (campaignId !== null && totalRaised !== null) {
        return {
          family: 'sponsor-crowdfunding',
          type: 'Settled',
          contractId,
          rawTopic: topic,
          payload: { campaignId, totalRaised },
        };
      }
    }
  } catch (err) {
    return {
      family: 'unknown',
      type: 'Unknown',
      contractId,
      rawTopic: topic,
      payload: { rawValue: val, reason: `Decoder error: ${String(err)}` },
    };
  }

  // Graceful fallback for unrecognized or future events
  return {
    family: 'unknown',
    type: 'Unknown',
    contractId,
    rawTopic: topic,
    payload: { rawValue: val, reason: `Unrecognized or malformed topic: ${topicName || 'empty'}` },
  };
}

/**
 * Decodes a collection of raw events into structured typed events.
 */
export function decodeAllContractEvents(
  rawEvents: readonly RawEventInput[]
): {
  decoded: DecodedContractEvent[];
  unhandled: UnknownDecodedEvent[];
  retainedUnknown: RetainedUnknownEvent[];
} {
  const decoded: DecodedContractEvent[] = [];
  const unhandled: UnknownDecodedEvent[] = [];
  const retainedUnknown: RetainedUnknownEvent[] = [];

  for (const raw of rawEvents) {
    const result = decodeContractEvent(raw);
    if (result.family === 'unknown') {
      unhandled.push(result as UnknownDecodedEvent);
      // Enforce canonical mapping at the parser boundary: unknown versions are
      // retained with their raw payload rather than dropped.
      const canonical = resolveCanonicalEvent(raw);
      if (canonical.status === 'retained-unknown') {
        retainedUnknown.push(canonical.event);
      }
    } else {
      decoded.push(result);
    }
  }

  return { decoded, unhandled, retainedUnknown };
}
