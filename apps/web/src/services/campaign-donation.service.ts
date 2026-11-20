import {
  CampaignDataSource,
  CampaignRecord,
  CampaignStatus,
  getCampaign,
  getCampaignDataSource,
  recordCampaignContribution,
} from "./campaign.service";
import {
  CampaignDonation,
  DONATION_ALLOCATION,
  DONATION_ALLOCATION_DESCRIPTION,
  DONATION_ALLOCATION_LABEL,
  DONATION_TOKENS,
  DonationReceipt,
  DonationSummary,
  DonationToken,
  MAX_DONATION_MESSAGE_LENGTH,
  donationReceiptReference,
  isDonationToken,
  normalizeDonationAmount,
  validateDonationAmount,
} from "@/types/campaign-donation";
import {
  IdempotencyConflictError,
  IdempotencyStore,
  getDefaultIdempotencyStore,
} from "@/services/idempotency";

/**
 * One-time charitable campaign donations (issue #1001).
 *
 * Donors contribute a flexible amount that is *not* tied to specific trees —
 * the funds are released to the campaign creator's discretion for project
 * costs. Every donation is written to the campaign contribution ledger (so the
 * raised total and funding milestones stay consistent) and produces a receipt
 * the donor can keep.
 *
 * Mirrors the in-memory singleton pattern used by the other campaign services
 * until a persistent data source lands.
 */

export type DonationErrorCode =
  | "INVALID_CAMPAIGN"
  | "CAMPAIGN_NOT_ACCEPTING"
  | "INVALID_AMOUNT"
  | "INVALID_TOKEN"
  | "INVALID_DONOR"
  | "MESSAGE_TOO_LONG"
  | "IDEMPOTENCY_CONFLICT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN";

/**
 * The authenticated principal making a donation-service request.
 *
 * `address` is the connected wallet; it is absent for anonymous callers.
 * Authorization for nested resources (a campaign's donations and receipts) is
 * decided here so every entry point enforces the same policy.
 */
export interface DonationPrincipal {
  address?: string | null;
  /** Explicit anonymous flag; anonymous principals are denied on read paths. */
  anonymous?: boolean;
}

/** Relationship between a principal and a campaign, used by the policy. */
export type CampaignRelationship = "owner" | "collaborator" | "donor" | "anonymous";

export type DonationAuthorizationResult =
  | { ok: true; relationship: CampaignRelationship; address: string }
  | { ok: false; error: string; code: "UNAUTHENTICATED" | "FORBIDDEN" };

const UNAUTHENTICATED_ERROR = "Connect a wallet to continue.";
const FORBIDDEN_ERROR = "You do not have access to this campaign's donations.";

/**
 * Resolve the relationship between a principal and a campaign.
 *
 * Owner and collaborator checks are delegated to the campaign record so the
 * policy stays in one place as campaign roles evolve. A principal that is not
 * an owner/collaborator but has donated to the campaign is a donor.
 */
export function resolveCampaignRelationship(
  principal: DonationPrincipal | null | undefined,
  campaign: CampaignRecord,
  donations: readonly CampaignDonation[] = [],
): DonationAuthorizationResult {
  const address = String(principal?.address ?? "").trim();
  if (!address || principal?.anonymous) {
    return { ok: false, error: UNAUTHENTICATED_ERROR, code: "UNAUTHENTICATED" };
  }

  const normalized = address.toLowerCase();
  const owner = String(campaign.creator ?? "").trim().toLowerCase();
  if (owner && owner === normalized) {
    return { ok: true, relationship: "owner", address };
  }

  const collaborators = (campaign.collaborators ?? []).map((entry) => String(entry).trim().toLowerCase());
  if (collaborators.includes(normalized)) {
    return { ok: true, relationship: "collaborator", address };
  }

  const isDonor = donations.some(
    (donation) => String(donation.donorAddress ?? "").trim().toLowerCase() === normalized,
  );
  if (isDonor) {
    return { ok: true, relationship: "donor", address };
  }

  return { ok: false, error: FORBIDDEN_ERROR, code: "FORBIDDEN" };
}

export interface CreateDonationInput {
  campaignId: string;
  donorAddress: string;
  amount: string | number;
  token?: string;
  message?: string;
  anonymous?: boolean;
  txHash?: string;
  /** Caller-supplied key that makes retries safe: a repeat call returns the original donation. */
  idempotencyKey?: string;
}

export type DonationResult =
  | {
      ok: true;
      donation: CampaignDonation;
      receipt: DonationReceipt;
      campaign: CampaignRecord;
      /** Funding milestones the donation pushed the campaign across. */
      milestones: number[];
    }
  | { ok: false; error: string; code: DonationErrorCode };

/** Campaign states that still accept new donations. */
export const DONATION_ACCEPTING_STATUSES: readonly CampaignStatus[] = ["ACTIVE"];

/** Idempotency scope for donation mutations: one namespace per campaign. */
const DONATION_IDEMPOTENCY_SCOPE = "campaign-donation";

/** How long a completed donation result is retained for replay (24h). */
export const DONATION_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export class CampaignDonationService {
  private donations = new Map<string, CampaignDonation[]>();
  private receipts = new Map<string, DonationReceipt>();

  constructor(private readonly idempotencyStore: IdempotencyStore = getDefaultIdempotencyStore()) {}

  private idempotencyScope(campaignId: string): string {
    return `${DONATION_IDEMPOTENCY_SCOPE}:${campaignId.trim()}`;
  }

  private campaignDonations(campaignId: string): CampaignDonation[] {
    return this.donations.get(campaignId.trim()) ?? [];
  }

  /**
   * Record a one-time donation and issue its receipt.
   *
   * Returns a discriminated result rather than throwing so the API route and UI
   * can map validation problems to status codes and inline messages.
   */
  async donate(
    input: CreateDonationInput,
    dataSource: CampaignDataSource = getCampaignDataSource(),
    now: number = Date.now(),
  ): Promise<DonationResult> {
    const campaignId = input.campaignId?.trim() ?? "";
    const donorAddress = String(input.donorAddress ?? "").trim();

    if (!donorAddress) {
      return { ok: false, error: "A connected wallet address is required.", code: "INVALID_DONOR" };
    }

    if (input.message && input.message.trim().length > MAX_DONATION_MESSAGE_LENGTH) {
      return {
        ok: false,
        error: `Your message must be ${MAX_DONATION_MESSAGE_LENGTH} characters or fewer.`,
        code: "MESSAGE_TOO_LONG",
      };
    }

    if (input.token !== undefined && !isDonationToken(input.token)) {
      return { ok: false, error: `Unsupported donation token: ${String(input.token)}.`, code: "INVALID_TOKEN" };
    }
    const token: DonationToken = isDonationToken(input.token) ? input.token : "XLM";

    const amountError = validateDonationAmount(input.amount);
    if (amountError) {
      return { ok: false, error: amountError, code: "INVALID_AMOUNT" };
    }
    const amount = normalizeDonationAmount(input.amount) as string;

    const campaign = await getCampaign(campaignId, dataSource);
    if (!campaign) {
      return { ok: false, error: "Campaign not found.", code: "INVALID_CAMPAIGN" };
    }
    if (!DONATION_ACCEPTING_STATUSES.includes(campaign.status)) {
      return {
        ok: false,
        error: `This campaign is ${campaign.status.toLowerCase()} and is not accepting donations.`,
        code: "CAMPAIGN_NOT_ACCEPTING",
      };
    }

    // Retries (double-clicks, network replays) resolve to the original record.
    // The idempotency key is scoped per campaign and the request payload is
    // fingerprinted so reusing a key with a different payload is rejected.
    const idempotencyKey = input.idempotencyKey?.trim();
    const scope = this.idempotencyScope(campaignId);
    const fingerprint = idempotencyKey
      ? JSON.stringify({
          campaignId,
          donorAddress,
          amount,
          token,
          message: input.message?.trim() || null,
          anonymous: Boolean(input.anonymous),
        })
      : undefined;

    if (idempotencyKey && fingerprint) {
      let reservation;
      try {
        reservation = await this.idempotencyStore.reserve(scope, idempotencyKey, fingerprint);
      } catch (error) {
        if (error instanceof IdempotencyConflictError) {
          return {
            ok: false,
            error: "This idempotency key was already used with a different request payload.",
            code: "IDEMPOTENCY_CONFLICT",
          };
        }
        throw error;
      }

      if (reservation.status === "completed") {
        const cached = reservation.result as
          | { donation: CampaignDonation; receipt: DonationReceipt; campaign: CampaignRecord; milestones: number[] }
          | undefined;
        if (cached) {
          return {
            ok: true,
            donation: cached.donation,
            receipt: cached.receipt,
            campaign: cached.campaign,
            milestones: [],
          };
        }
      }
    }

    // Reuse the campaign contribution ledger so raised totals and the
    // creator's funding-milestone notifications behave exactly as for any
    // other contribution. Donations are whole tokens, matching the ledger.
    const recorded = await recordCampaignContribution(campaignId, amount, dataSource);
    if (!recorded) {
      if (idempotencyKey) {
        await this.idempotencyStore.release(scope, idempotencyKey);
      }
      return { ok: false, error: "Campaign not found.", code: "INVALID_CAMPAIGN" };
    }

    const donation: CampaignDonation = {
      id: `dn-${now}-${Math.random().toString(36).slice(2, 8)}`,
      campaignId,
      donorAddress,
      amount,
      token,
      allocation: DONATION_ALLOCATION,
      message: input.message?.trim() || undefined,
      anonymous: Boolean(input.anonymous),
      status: "CONFIRMED",
      txHash: input.txHash?.trim() || undefined,
      idempotencyKey: idempotencyKey || undefined,
      createdAt: now,
      confirmedAt: now,
    };

    const receipt: DonationReceipt = {
      receiptId: `rc-${donation.id}`,
      reference: donationReceiptReference(campaignId, donation.id),
      donationId: donation.id,
      campaignId,
      campaignName: recorded.campaign.name,
      donorAddress,
      amount,
      token,
      allocation: DONATION_ALLOCATION,
      allocationLabel: DONATION_ALLOCATION_LABEL,
      allocationDescription: DONATION_ALLOCATION_DESCRIPTION,
      status: donation.status,
      issuedAt: now,
    };

    const list = this.campaignDonations(campaignId);
    list.push(donation);
    this.donations.set(campaignId, list);
    this.receipts.set(donation.id, receipt);

    const result = {
      donation,
      receipt,
      campaign: recorded.campaign,
      milestones: recorded.milestones,
    };

    if (idempotencyKey) {
      await this.idempotencyStore.complete(
        scope,
        idempotencyKey,
        fingerprint as string,
        result,
        DONATION_IDEMPOTENCY_TTL_SECONDS,
      );
    }

    return { ok: true, ...result };
  }

  /**
   * Every donation recorded for a campaign, oldest first.
   *
   * Authorization: owners and collaborators may read the full campaign ledger;
   * donors may read only their own donations; anonymous callers are denied.
   */
  async getDonations(
    campaignId: string,
    principal: DonationPrincipal | null | undefined,
    dataSource: CampaignDataSource = getCampaignDataSource(),
  ): Promise<DonationAccessResult<CampaignDonation[]>> {
    const campaign = await getCampaign(campaignId?.trim() ?? "", dataSource);
    if (!campaign) {
      return { ok: false, error: "Campaign not found.", code: "INVALID_CAMPAIGN" };
    }

    const donations = this.campaignDonations(campaignId);
    const authorization = resolveCampaignRelationship(principal, campaign, donations);
    if (!authorization.ok) {
      return authorization;
    }

    if (authorization.relationship === "donor") {
      const normalized = authorization.address.toLowerCase();
      return {
        ok: true,
        relationship: authorization.relationship,
        value: donations.filter(
          (donation) => String(donation.donorAddress ?? "").trim().toLowerCase() === normalized,
        ),
      };
    }

    return { ok: true, relationship: authorization.relationship, value: [...donations] };
  }

  /**
   * Fetch a receipt by donation id.
   *
   * Authorization: the receipt is a nested resource of the donation, so only
   * the donating wallet, the campaign owner, or a collaborator may read it.
   */
  async getReceipt(
    donationId: string,
    principal: DonationPrincipal | null | undefined,
    dataSource: CampaignDataSource = getCampaignDataSource(),
  ): Promise<DonationAccessResult<DonationReceipt>> {
    const receipt = this.receipts.get(donationId);
    if (!receipt) {
      return { ok: false, error: "Receipt not found.", code: "INVALID_CAMPAIGN" };
    }

    const campaign = await getCampaign(receipt.campaignId, dataSource);
    if (!campaign) {
      return { ok: false, error: "Campaign not found.", code: "INVALID_CAMPAIGN" };
    }

    const donations = this.campaignDonations(receipt.campaignId);
    const authorization = resolveCampaignRelationship(principal, campaign, donations);
    if (!authorization.ok) {
      return authorization;
    }

    if (authorization.relationship === "donor") {
      const normalized = authorization.address.toLowerCase();
      const ownsReceipt = String(receipt.donorAddress ?? "").trim().toLowerCase() === normalized;
      if (!ownsReceipt) {
        return { ok: false, error: FORBIDDEN_ERROR, code: "FORBIDDEN" };
      }
    }

    return { ok: true, relationship: authorization.relationship, value: receipt };
  }

  /**
   * Exact per-token totals for a campaign so mixed tokens are never summed.
   *
   * Authorization: aggregate totals are public campaign data, so anonymous
   * callers may read the summary; individual donations stay protected.
   */
  getSummary(campaignId: string): DonationSummary {
    const donations = this.campaignDonations(campaignId);
    const totalsByToken: Record<DonationToken, string> = { XLM: "0", USDC: "0" };

    for (const token of DONATION_TOKENS) {
      const total = donations
        .filter((donation) => donation.token === token)
        .reduce((sum, donation) => sum + BigInt(donation.amount), 0n);
      totalsByToken[token] = total.toString();
    }

    const latestDonationAt = donations.reduce<number | undefined>(
      (latest, donation) => (latest === undefined ? donation.createdAt : Math.max(latest, donation.createdAt)),
      undefined,
    );

    return {
      campaignId,
      donationCount: donations.length,
      totalsByToken,
      latestDonationAt,
    };
  }

  /** Test helper — wipes every in-memory collection. */
  async reset(): Promise<void> {
    this.donations.clear();
    this.receipts.clear();
    await this.idempotencyStore.clearScope(DONATION_IDEMPOTENCY_SCOPE);
  }
}

/** Discriminated result for authorized read paths. */
export type DonationAccessResult<T> =
  | { ok: true; relationship: CampaignRelationship; value: T }
  | { ok: false; error: string; code: DonationErrorCode };

export const donationService = new CampaignDonationService();
