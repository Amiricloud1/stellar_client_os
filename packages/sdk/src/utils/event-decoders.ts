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
  | BaseDecodedEvent<'campaign-funding', 'CampaignFinalized', { campaignId: bigint; success: boolean }>;

export type CampaignDiversityDecodedEvent =
  | BaseDecodedEvent<'campaign-diversity', 'DiversityScored', { campaignId: bigint; score: number }>;

export type SponsorCrowdfundingDecodedEvent =
  | BaseDecodedEvent<'sponsor-crowdfunding', 'Pledged', { campaignId: bigint; sponsor: string; amount: bigint }>
  | BaseDecodedEvent<'sponsor-crowdfunding', 'Settled', { campaignId: bigint; totalRaised: bigint }>;

export type UnknownDecodedEvent = BaseDecodedEvent<'unknown', 'Unknown', { rawValue: unknown; reason: string }>;

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
} {
  const decoded: DecodedContractEvent[] = [];
  const unhandled: UnknownDecodedEvent[] = [];

  for (const raw of rawEvents) {
    const result = decodeContractEvent(raw);
    if (result.family === 'unknown') {
      unhandled.push(result as UnknownDecodedEvent);
    } else {
      decoded.push(result);
    }
  }

  return { decoded, unhandled };
}
