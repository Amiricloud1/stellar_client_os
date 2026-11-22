//! # Campaign Funding Contract
//!
//! Soroban smart contract governing the full lifecycle of tree-planting
//! fundraising campaigns.  It addresses four security objectives:
//!
//! ## Issue 1 — Versioned fee parameters
//! Protocol fee changes are version-stamped.  Every campaign records the fee
//! version that was current when it was created, so later admin rate changes
//! only affect new campaigns; existing campaigns keep their original terms.
//!
//! ## Issue 2 — Balance conservation
//! Sponsor contributions, protocol-fee liabilities, and insurance-pool
//! deposits are held in separate ledger buckets (`SponsorBalance`,
//! `FeeLiability`, `InsurancePool`).  `claim_funds` asserts that the
//! transferred amounts sum exactly to `total_raised` before touching tokens.
//!
//! ## Issue 3 — Atomic / double-spend-proof match and donation flows
//! Each `contribute` call uses a check-effects-interactions pattern:
//! balances are updated in storage *before* the token transfer.  The
//! matching fund is consumed with a single checked-subtract that panics on
//! over-draw; a `MatchingClaimUsed` flag prevents a contributor from
//! claiming matching more than once per campaign.
//!
//! ## Issue 4 — Scoped, revocable delegates
//! Delegates are constrained to a specific `(delegator, campaign_id, token,
//! max_amount, nonce, expiry)` tuple.  Every use decrements the allowance
//! atomically; expiry is enforced at call time; explicit revocation zeroes
//! the allowance; there are no unrestricted ("approve all") paths.

#![no_std]
pub mod checked_math;
pub use checked_math::CheckedMath;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, Bytes, BytesN, Env, String, Vec,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Optional `Address` wrapper suitable for use inside `#[contracttype]` structs.
///
/// Soroban's `#[contracttype]` macro does not support generic type parameters,
/// so we cannot use `Option<Address>` directly.  This enum provides the same
/// semantics.
#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum OptionalAddress {
    None,
    Some(Address),
}

// ---------------------------------------------------------------------------
// Storage key enumeration
// ---------------------------------------------------------------------------

/// Every persistent storage path in the contract.
///
/// Using a typed enum keeps all paths collision-free and self-documenting.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    // ---- escrow sub-contract keys ----
    CampaignEscrow(u64),
    CampaignSpeciesList(u64),
    CampaignSpeciesCount(u64, BytesN<32>),
    CampaignDiversityScore(u64),

    // ---- instance (global) keys ----
    /// Global admin address.
    Admin,
    /// Running total of campaigns created.
    CampaignCount,
    /// Protocol fee collector address.
    FeeCollector,
    /// Current protocol fee rate in basis points.
    FeeRate,
    /// Issue 1: monotonically increasing fee-parameter version counter.
    FeeVersion,
    /// Insurance pool balance keyed by token address.
    InsurancePool(Address),
    /// Insurance fee rate in basis points.
    InsuranceFeeRate,
    /// Payment-stream contract address.
    StreamContract,

    // ---- persistent (per-campaign / per-contributor) keys ----
    /// Full [`Campaign`] struct keyed by campaign ID.
    Campaign(u64),
    /// Issue 1: fee-version snapshot recorded at campaign creation.
    CampaignFeeVersion(u64),
    /// Issue 1: fee-rate snapshot recorded at campaign creation.
    CampaignFeeRateSnapshot(u64),
    /// Per-contributor escrow balance keyed by `(campaign_id, contributor)`.
    Contribution(u64, Address),
    /// Campaign metadata IPFS CID or hex hash.
    CampaignIpfsHash(u64),
    /// Total count of tree planting records.
    PlantingCount(u64),
    /// Tree planting verification SLA record.
    PlantingSla(u64, u64),
    /// Status history entry keyed by `(campaign_id, entry_index)`.
    StatusHistory(u64, u32),
    /// Total number of status history entries for a campaign.
    StatusHistoryCount(u64),
    /// Bitmask of campaign goal milestones reached (25/50/75/100 %).
    MilestonesReached(u64),
    /// Verified tree count aggregate for campaign reward eligibility.
    VerifiedTreeCount(u64),
    /// Bitmask of one-time tree reward unlocks (1k, 5k, 10k).
    RewardsUnlocked(u64),
    /// Reserve pool balance for tree replacement (10 % of raised funds).
    Reserve(u64),
    /// Team members configuration.
    TeamMembers(u64),
    /// Gross contribution stored separately so refunds are always exact.
    OriginalContribution(u64, Address),
    /// Admin-funded matching cap for a campaign.
    MatchingCap(u64),
    /// Running total of matching funds already consumed.
    MatchingUsed(u64),
    /// Remaining matching pool balance.
    MatchingBalance(u64),
    /// Issue 3: flag preventing a contributor from double-claiming matching.
    MatchingClaimUsed(u64, Address),
    /// Flag indicating a reward stream has been started for a contributor.
    RewardStreamed(u64, Address),
    /// ERC-20–compatible carbon credit token contract address per campaign.
    CarbonToken(u64),
    /// Flag indicating carbon credit tokens have been minted.
    CarbonCreditsMinted(u64),
    /// CO₂ multiplier for a campaign.
    Co2Multiplier(u64),
    /// Declared tree species list.
    DeclaredSpeciesList(u64),
    /// Species verification proof keyed by (campaign_id, planting_id).
    SpeciesProof(u64, u64),
    /// Number of group sponsorships created for a campaign.
    GroupSponsorshipCount(u64),
    /// Group sponsorship details.
    GroupSponsorship(u64, u64),

    // ---- Issue 2: separate balance buckets ----
    /// Sponsor-deposited funds not yet subject to fee/insurance deduction.
    SponsorBalance(u64),
    /// Protocol fee liability accrued for a campaign (deducted at claim time).
    FeeLiability(u64),

    // ---- Issue 4: delegate keys ----
    /// Scoped delegate allowance: `(delegator, campaign_id, nonce)`.
    Delegate(Address, u64, u64),
    /// Per-delegator nonce counter (incremented on every grant or revoke).
    DelegatorNonce(Address),
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/// Current lifecycle state of a campaign.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CampaignStatus {
    /// Open and accepting contributions.
    Active,
    /// Minimum target met; creator may claim the raised funds.
    Successful,
    /// Verifier has approved trees are planted.
    Verified,
    /// Deadline passed without reaching the minimum target; contributors may
    /// claim full refunds.
    Failed,
    /// Creator has already claimed the raised funds.
    Claimed,
    /// Trees died during verification; sponsors are entitled to insurance
    /// refunds from the insurance pool.
    VerificationFailed,
    /// Campaign has been temporarily halted by the admin.
    Paused,
}

// ---------------------------------------------------------------------------
// PHASE 1: Objective 3 - Network Binding
// ---------------------------------------------------------------------------

/// Unique deployment identity capturing the network context and contract address.
/// This struct is stored once at contract initialization and serves as proof
/// of the specific Stellar network and deployment location.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeploymentIdentity {
    /// Hash of the network identifier (e.g., Stellar testnet, public network).
    /// Prevents cross-network attacks and fund mixing.
    pub network_id: BytesN<32>,
    /// The address of this contract instance on the network.
    pub contract_address: Address,
    /// Unix timestamp (seconds) when this contract was deployed.
    /// Enables ordering and verification of deployment sequence.
    pub deploy_timestamp: u64,
}

/// Asset-to-network binding for verification that assets belong to the intended network.
/// Each asset can be bound to exactly one network, preventing cross-network asset swaps.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetNetworkBinding {
    /// The token/asset contract address being bound.
    pub asset: Address,
    /// The network this asset is verified to belong to.
    pub network_id: BytesN<32>,
    /// Whether the binding has been cryptographically verified by validators.
    pub verified: bool,
}

// ---------------------------------------------------------------------------
// PHASE 2: Objective 1 - Campaign Retirement
// ---------------------------------------------------------------------------

/// Campaign lifecycle state enum defining the extended state machine.
/// Extends `CampaignStatus` to include retirement and read-only migration states.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CampaignLifecycle {
    /// Campaign is in normal operation (corresponds to any CampaignStatus except Paused).
    Active = 0,
    /// Campaign has transitioned to read-only migration mode.
    /// All write operations (deposits, payouts) are forbidden.
    /// Existing data is preserved for auditing and historical reference.
    ReadOnlyMigration = 1,
    /// Campaign is fully retired and archived.
    /// Contract storage is no longer actively managed; historical queries only.
    RetiredReadOnly = 2,
}

// ---------------------------------------------------------------------------
// PHASE 3: Objective 2 - Granular Pause Controls
// ---------------------------------------------------------------------------

/// Fine-grained operation pause flags allowing independent control of operations.
/// This enables targeted pausing of deposits, payouts, or claims without
/// completely freezing the campaign (which CampaignStatus::Paused would do).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationPauseFlags {
    /// If true, new deposits/contributions are prevented.
    pub pause_deposits: bool,
    /// If true, fund payouts and releases are prevented.
    pub pause_payouts: bool,
    /// If true, contributor refund claims are prevented.
    pub pause_claims: bool,
    /// If true, admin operations (like fee changes) are prevented.
    pub pause_admin: bool,
}

// ---------------------------------------------------------------------------
// PHASE 4: Objective 4 - Asset Metadata & Risk
// ---------------------------------------------------------------------------

/// Asset metadata tracking issuer identity and verification status.
/// Enables campaign creators to vet which tokens are acceptable.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetMetadata {
    /// The token contract address.
    pub token: Address,
    /// The issuer/creator of this token.
    pub issuer: Address,
    /// Unix timestamp (seconds) when this asset was first verified.
    pub verified_at: u64,
    /// Unix timestamp (seconds) of the most recent review or update.
    pub last_review: u64,
}

/// Asset review status tracking verification and flag state.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AssetReviewStatus {
    /// Asset is awaiting initial review.
    Pending = 0,
    /// Asset has been reviewed and approved for use in campaigns.
    Approved = 1,
    /// Asset has been flagged for risk, scam, or other issues.
    Flagged = 2,
    /// Asset is permanently retired from use.
    Retired = 3,
}

/// Risk flags aggregating multiple forms of asset risk assessment.
/// Each flag represents a specific category of risk that may make an asset
/// unsuitable for campaign funding.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetRiskFlags {
    /// Issuer has poor reputation or history of scams/fraud.
    pub reputation_risk: bool,
    /// Asset has low liquidity or concentrated holders.
    pub liquidity_risk: bool,
    /// Asset is held by a small number of whales (concentration risk).
    pub concentration_risk: bool,
}

/// Single entry in a campaign's status history.
#[contracttype]
#[derive(Clone)]
pub struct StatusHistoryEntry {
    pub status: CampaignStatus,
    pub timestamp: u64,
}

/// Bonus parameters for a tree-survival reward calculation.
#[contracttype]
#[derive(Clone)]
pub struct BonusParams {
    pub target_co2: i128,
    pub actual_co2: i128,
    pub trees_planted: u32,
    pub trees_survived: u32,
    pub treasury: Address,
    pub planter: Address,
    pub carbon_token: Address,
    pub bonus_token: Address,
    pub co2_bonus_amount: i128,
    pub planter_bonus_amount: i128,
}

/// Core campaign record stored on-chain.
#[contracttype]
#[derive(Clone)]
pub struct Campaign {
    pub id: u64,
    pub creator: Address,
    pub creators: Vec<Address>,
    pub revenue_shares: Vec<u32>,
    pub token: Address,
    /// Hard cap: auto-transitions to `Successful` when reached.
    pub target_amount: i128,
    /// Minimum threshold: must be met by `deadline` or contributions refund.
    pub min_target: i128,
    pub deadline: u64,
    pub total_raised: i128,
    pub status: CampaignStatus,
    pub created_at: u64,
    pub planter: OptionalAddress,
    pub co2_multiplier: u32,
    
    // PHASE 1: Objective 3 - Network Binding
    /// SHA-256 hash of the deployment network identifier.
    /// Ensures this campaign cannot be cross-chain attacked or replayed.
    pub deployment_id: BytesN<32>,
    /// SHA-256 hash of the network this campaign belongs to.
    /// Used to verify all funding tokens are from the same network.
    pub network_id: BytesN<32>,
    
    // PHASE 2: Objective 1 - Campaign Retirement
    /// Extended lifecycle state including retirement tracking.
    pub lifecycle_state: CampaignLifecycle,
    
    // PHASE 3: Objective 2 - Granular Pause Controls
    /// Fine-grained pause flags for individual operations.
    /// Allows selective freezing without full campaign pause.
    pub pause_flags: OperationPauseFlags,
}

/// A single co-creator and their revenue share in basis points.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamMember {
    pub address: Address,
    /// Share of net proceeds in basis points (sum across all members = 10 000).
    pub percentage_bps: u32,
}

/// A named group of sponsors funding a campaign together.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GroupSponsorship {
    pub campaign_id: u64,
    pub group_id: u64,
    pub name: soroban_sdk::String,
    pub organizer: Address,
    pub total_contributed: i128,
}

/// Declared tree species configuration for a campaign.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeclaredSpecies {
    pub species_name: soroban_sdk::String,
    pub species_code: BytesN<32>,
    pub target_count: u64,
}

/// Photographic species proof record for a planting batch.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpeciesVerificationProof {
    pub planting_id: u64,
    pub species_code: BytesN<32>,
    pub photo_ipfs_cid: soroban_sdk::String,
    pub photo_hash: BytesN<32>,
    pub is_verified: bool,
}

/// Proof of tree species planted, linking uploaded photo hash to declared species.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpeciesPhotoProof {
    pub photo_hash: BytesN<32>,
    pub species: String,
    pub tree_count: u32,
}

/// Tree planting verification SLA record.
#[contracttype]
#[derive(Clone)]
pub struct PlantingSlaRecord {
    pub planting_id: u64,
    pub campaign_id: u64,
    pub planter: Address,
    pub tree_count: u32,
    pub planted_at: u64,
    pub verification_deadline: u64,
    pub is_verified: bool,
    pub verified_at: u64,
    pub is_refunded: bool,
}

/// Entitlement unlocked by a campaign's verified tree count.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RewardTier {
    /// Unlocked at 1 000 verified trees.
    CustomBranding,
    /// Unlocked at 5 000 verified trees.
    WhiteLabel,
    /// Unlocked at 10 000 verified trees.
    ApiAccess,
}

// ---- Issue 2: escrow sub-system ----

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Held = 0,
    Verified = 1,
    Released = 2,
    Disputed = 3,
}

/// Per-campaign escrow account.
///
/// Issue 2: `total_escrowed` and `released_amount` track only sponsor funds.
/// Protocol fee liability is recorded separately under `DataKey::FeeLiability`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowAccount {
    pub campaign_id: u64,
    pub verifier: Address,
    /// Gross sponsor funds deposited into this escrow (fee not yet deducted).
    pub total_escrowed: i128,
    pub released_amount: i128,
    pub status: EscrowStatus,
    pub is_verified: bool,
    pub trees_planted: u64,
    pub target_trees: u64,
}

// ---- Issue 4: delegate record ----

/// A scoped, time-limited delegation authorizing a third party to act on
/// behalf of `delegator` for exactly one `(campaign_id, token)` pair.
///
/// Design constraints (Issue 4):
/// - Bounded by `campaign_id` and `token` — no cross-campaign or cross-asset use.
/// - `max_amount` caps the total value that may be spent under this grant.
/// - `nonce` makes every grant unique and allows multiple outstanding grants.
/// - `expiry` is a hard ledger-timestamp cutoff; expired grants are dead.
/// - Explicit `revoke_delegate` zeroes `remaining_amount`; there is no
///   catch-all "approve everything" path.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DelegateGrant {
    pub delegator: Address,
    pub delegate: Address,
    pub campaign_id: u64,
    pub token: Address,
    /// Maximum cumulative amount that may be spent under this grant.
    pub max_amount: i128,
    /// Remaining unspent allowance (decremented atomically on each use).
    pub remaining_amount: i128,
    /// Unique sequence number for this delegator, assigned at grant time.
    pub nonce: u64,
    /// Unix timestamp (seconds) after which the grant is invalid.
    pub expiry: u64,
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/// Emitted when a new campaign is created.
#[contractevent]
#[derive(Clone)]
pub struct CampaignCreatedEvent {
    pub campaign_id: u64,
    pub creator: Address,
    pub token: Address,
    pub target_amount: i128,
    pub min_target: i128,
    pub deadline: u64,
    pub co2_multiplier: u32,
    pub tree_species: soroban_sdk::String,
    /// Issue 1: fee version at the time of campaign creation.
    pub fee_version: u64,
    /// Issue 1: fee rate (bps) locked in for this campaign.
    pub fee_rate_bps: u32,
}

/// Emitted each time a contributor adds tokens to a campaign.
#[contractevent]
#[derive(Clone)]
pub struct ContributionMadeEvent {
    pub campaign_id: u64,
    pub contributor: Address,
    pub amount: i128,
    pub total_raised: i128,
}

/// Contribution event used when a sponsor chooses anonymity on public surfaces.
#[contracttype]
#[derive(Clone)]
pub struct AnonymousContributionMadeEvent {
    pub campaign_id: u64,
    pub amount: i128,
    pub total_raised: i128,
}

/// Emitted when a campaign transitions lifecycle states.
#[contractevent]
#[derive(Clone)]
pub struct CampaignStatusChangedEvent {
    pub campaign_id: u64,
    pub new_status: CampaignStatus,
}

/// Emitted when a planter is assigned to a campaign.
#[contracttype]
#[derive(Clone)]
pub struct PlanterAssignedEvent {
    pub campaign_id: u64,
    pub planter: Address,
    pub assigned_at: u64,
}

/// Emitted when the campaign creator claims the raised funds.
#[contractevent]
#[derive(Clone)]
pub struct FundsClaimedEvent {
    pub campaign_id: u64,
    pub creator: Address,
    pub amount: i128,
}

/// Emitted when the verifier approves a campaign's escrow for payout.
#[contracttype]
#[derive(Clone)]
pub struct CampaignVerificationApprovedEvent {
    pub campaign_id: u64,
    pub approved_at: u64,
}

/// Emitted each time a contributor successfully claims a refund.
#[contractevent]
#[derive(Clone)]
pub struct RefundIssuedEvent {
    pub campaign_id: u64,
    pub contributor: Address,
    pub amount: i128,
}

/// Emitted when campaign IPFS metadata hash is updated.
#[contracttype]
#[derive(Clone)]
pub struct CampaignIpfsHashUpdatedEvent {
    pub campaign_id: u64,
    pub ipfs_hash: soroban_sdk::String,
}

/// Emitted when a tree planting batch is recorded with 30-day SLA window.
#[contracttype]
#[derive(Clone)]
pub struct TreePlantingRecordedEvent {
    pub campaign_id: u64,
    pub planting_id: u64,
    pub planter: Address,
    pub tree_count: u32,
    pub verification_deadline: u64,
}

/// Emitted when tree planting is verified on-chain.
#[contracttype]
#[derive(Clone)]
pub struct TreePlantingVerifiedEvent {
    pub campaign_id: u64,
    pub planting_id: u64,
    pub verified_at: u64,
}

/// Emitted when campaign creator specifies or declares tree species.
#[contracttype]
#[derive(Clone)]
pub struct SpeciesDeclaredEvent {
    pub campaign_id: u64,
    pub species: Vec<String>,
}

/// Emitted when tree planting photo proof matching declared species is verified.
#[contracttype]
#[derive(Clone)]
pub struct SpeciesProofVerifiedEvent {
    pub campaign_id: u64,
    pub planting_id: u64,
    pub photo_hash: BytesN<32>,
    pub species: String,
    pub tree_count: u32,
}

/// Emitted once when a campaign crosses a verified-tree reward threshold.
#[contractevent(topics = ["RewardUnlocked"])]
#[derive(Clone)]
pub struct RewardUnlockedEvent {
    pub campaign_id: u64,
    pub tier: RewardTier,
    pub threshold: u64,
    pub verified_tree_count: u64,
}

/// Emitted when SLA verification refund is issued for unverified tree planting.
#[contracttype]
#[derive(Clone)]
pub struct SlaRefundIssuedEvent {
    pub campaign_id: u64,
    pub planting_id: u64,
    pub contributor: Address,
    pub amount: i128,
}

/// Emitted when cumulative contributions cross one of a campaign's funding milestones.
#[contractevent(topics = ["MilestoneReached"])]
#[derive(Clone)]
pub struct MilestoneReachedEvent {
    pub campaign_id: u64,
    pub percentage: u32,
    pub total_raised: i128,
    pub target_amount: i128,
}

/// Emitted when the protocol fee is collected during `claim_funds`.
#[contractevent(topics = ["ProtocolFeeCollected"])]
#[derive(Clone)]
pub struct ProtocolFeeCollectedEvent {
    pub campaign_id: u64,
    pub token: Address,
    pub fee_collector: Address,
    pub amount: i128,
}

/// Emitted when 10 % of campaign funds are reserved for tree replacement.
#[contractevent(topics = ["ReserveAllocated"])]
#[derive(Clone)]
pub struct ReserveAllocatedEvent {
    pub campaign_id: u64,
    pub amount: i128,
}

/// Emitted when a team member receives their share of campaign proceeds.
#[contractevent(topics = ["TeamPayoutIssued"])]
#[derive(Clone)]
pub struct TeamPayoutIssuedEvent {
    pub campaign_id: u64,
    pub member: Address,
    pub amount: i128,
}

/// Emitted when the ContractFull error occurs.
#[contracttype]
#[derive(Clone)]
pub struct ContractFullEvent {
    pub timestamp: u64,
}

/// Emitted once when carbon credit tokens are minted for a verified campaign.
#[contracttype]
#[derive(Clone)]
pub struct CarbonCreditsMintedEvent {
    pub campaign_id: u64,
    pub total_minted: i128,
    pub co2_multiplier: u32,
    pub verified_tree_count: u64,
}

/// Emitted when dynamic supply/demand pricing is evaluated for a campaign.
#[contractevent(topics = ["DynamicPricingEvaluated"])]
pub struct DynamicPricingEvaluatedEvent {
    pub campaign_id: u64,
    pub base_cost: i128,
    pub dynamic_cost: i128,
    pub multiplier_bps: u32,
}

/// Emitted when a group sponsorship is created.
#[contracttype]
#[derive(Clone)]
pub struct GroupSponsorshipCreatedEvent {
    pub campaign_id: u64,
    pub group_id: u64,
    pub name: soroban_sdk::String,
    pub organizer: Address,
}

/// Emitted when a sponsor contributes through a group sponsorship.
#[contracttype]
#[derive(Clone)]
pub struct GroupContributionMadeEvent {
    pub campaign_id: u64,
    pub group_id: u64,
    pub contributor: Address,
    pub amount: i128,
    pub group_total: i128,
}

/// Emitted when a delegate grant is created (Issue 4).
#[contracttype]
#[derive(Clone)]
pub struct DelegateGrantedEvent {
    pub delegator: Address,
    pub delegate: Address,
    pub campaign_id: u64,
    pub token: Address,
    pub max_amount: i128,
    pub nonce: u64,
    pub expiry: u64,
}

/// Emitted when a delegate is explicitly revoked (Issue 4).
#[contracttype]
#[derive(Clone)]
pub struct DelegateRevokedEvent {
    pub delegator: Address,
    pub campaign_id: u64,
    pub nonce: u64,
}

/// Emitted when a delegate spend is executed (Issue 4).
#[contracttype]
#[derive(Clone)]
pub struct DelegateSpentEvent {
    pub delegator: Address,
    pub delegate: Address,
    pub campaign_id: u64,
    pub amount: i128,
    pub remaining: i128,
}

// ---- Escrow sub-system events ----

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpeciesPlantingRecordedEvent {
    pub campaign_id: u64,
    pub species_code: BytesN<32>,
    pub count: u64,
    pub new_diversity_score: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiversityScoreUpdatedEvent {
    pub campaign_id: u64,
    pub diversity_score: u32,
    pub distinct_species: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowAccountCreatedEvent {
    pub campaign_id: u64,
    pub verifier: Address,
    pub target_trees: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowDepositEvent {
    pub campaign_id: u64,
    pub depositor: Address,
    pub amount: i128,
    pub total_escrowed: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowVerifiedEvent {
    pub campaign_id: u64,
    pub verifier: Address,
    pub trees_planted: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowFundsReleasedEvent {
    pub campaign_id: u64,
    pub creator: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InsurancePoolFundedEvent {
    pub campaign_id: u64,
    pub token: Address,
    pub amount: i128,
    pub pool_balance: i128,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpeciesProofSubmittedEvent {
    pub campaign_id: u64,
    pub planting_id: u64,
    pub species_code: BytesN<32>,
    pub photo_ipfs_cid: soroban_sdk::String,
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/// Exhaustive error enumeration for the campaign-funding contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InvalidAmount = 4,
    InvalidDeadline = 5,
    InvalidTarget = 6,
    CampaignNotFound = 7,
    CampaignNotActive = 8,
    DeadlineNotReached = 9,
    CampaignNotFailed = 10,
    CampaignNotSuccessful = 11,
    NoContributionFound = 12,
    AlreadyClaimed = 13,
    FeeTooHigh = 14,
    ArithmeticOverflow = 15,
    TargetExceeded = 16,
    DeadlineTooFar = 17,
    SlaNotBreached = 18,
    PlantingNotFound = 19,
    AlreadyVerified = 20,
    CampaignNotVerificationFailed = 21,
    InsuranceFeeTooHigh = 22,
    TeamEmpty = 23,
    TeamInvalidSplit = 24,
    TeamDuplicateMember = 25,
    ContractFull = 26,
    CampaignNotVerified = 27,
    CampaignPaused = 28,
    CampaignNotClaimed = 29,
    RewardsAlreadyStreamed = 30,
    StreamContractNotSet = 31,
    InvalidCreators = 32,
    CarbonTokenNotSet = 33,
    CarbonCreditsAlreadyMinted = 34,
    GroupSponsorshipNotFound = 35,
    GroupNameEmpty = 36,
    GroupNameTooLong = 37,
    SpeciesMismatch = 38,
    ProofNotFound = 39,
    EscrowNotVerified = 40,
    EscrowAlreadyReleased = 41,
    UnauthorizedVerifier = 42,
    EscrowDisputed = 43,
    EscrowNotInitialized = 44,
    EscrowAlreadyInitialized = 45,
    InsuranceWindowExpired = 46,
    NonProfitPartnerNotFound = 47,
    CertificateAlreadyIssued = 48,
    // Issue 3
    MatchingAlreadyClaimed = 49,
    MatchingCapExceeded = 50,
    // Issue 4
    DelegateNotFound = 51,
    DelegateExpired = 52,
    DelegateInsufficient = 53,
    DelegateInvalidNonce = 54,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum protocol fee: 500 bps = 5 %.
const MAX_FEE_RATE_BPS: u32 = 500;
/// Maximum insurance fee rate: 500 bps = 5 %.
const MAX_INSURANCE_FEE_BPS: u32 = 500;
/// Maximum campaign duration: 180 days in seconds.
const MAX_DEADLINE_SECS: u64 = 180 * 24 * 60 * 60;
/// Reserve allocation: 10 % of raised funds for dead-tree replacement.
const RESERVE_BPS: u32 = 1_000;
/// Dynamic pricing surge threshold: 90 % of target_amount.
const SURGE_THRESHOLD_BPS: u32 = 9_000;
/// Dynamic pricing surge multiplier: 1.5× = 15 000 bps.
const SURGE_MULTIPLIER_BPS: u32 = 15_000;
/// Dynamic pricing intermediate threshold: 50 % of target_amount.
const MID_THRESHOLD_BPS: u32 = 5_000;
/// Dynamic pricing intermediate multiplier: 1.1× = 11 000 bps.
const MID_MULTIPLIER_BPS: u32 = 11_000;
/// Base (below 50 %) multiplier: 1.0× = 10 000 bps.
const BASE_MULTIPLIER_BPS: u32 = 10_000;
/// Planting SLA window: 30 days in seconds.
const SLA_WINDOW_SECS: u64 = 30 * 24 * 60 * 60;
/// Group name maximum byte length.
const GROUP_NAME_MAX_BYTES: u32 = 64;
/// Storage TTL threshold: ~30 days at 5 s/ledger.
const LEDGER_THRESHOLD: u32 = 518_400;
/// Storage TTL bump: ~31 days at 5 s/ledger.
const LEDGER_BUMP: u32 = 535_680;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct CampaignFundingContract;

#[contractimpl]
impl CampaignFundingContract {
    // -----------------------------------------------------------------------
    // Initialisation
    // -----------------------------------------------------------------------

    /// Initialize the contract with an admin address, fee collector, fee rate,
    /// and insurance fee rate.
    ///
    /// Issue 1: seeds the global fee version at 1 so the first fee-params
    /// snapshot is unambiguous.
    pub fn initialize(
        env: Env,
        admin: Address,
        fee_collector: Address,
        fee_rate_bps: u32,
        insurance_fee_rate_bps: u32,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        admin.require_auth();

        if fee_rate_bps > MAX_FEE_RATE_BPS {
            panic_with_error!(&env, Error::FeeTooHigh);
        }
        if insurance_fee_rate_bps > MAX_INSURANCE_FEE_BPS {
            panic_with_error!(&env, Error::InsuranceFeeTooHigh);
        }

        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::FeeCollector, &fee_collector);
        storage.set(&DataKey::FeeRate, &fee_rate_bps);
        // Issue 1: start version counter at 1.
        storage.set(&DataKey::FeeVersion, &1u64);
        storage.set(&DataKey::InsuranceFeeRate, &insurance_fee_rate_bps);
        storage.set(&DataKey::CampaignCount, &0u64);
        storage.extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);
    }

    // -----------------------------------------------------------------------
    // Issue 1: Versioned fee management
    // -----------------------------------------------------------------------

    /// Update the protocol fee rate.
    ///
    /// Increments `FeeVersion` atomically so every future campaign records a
    /// new snapshot; existing campaigns keep their old `CampaignFeeRateSnapshot`.
    pub fn set_fee_rate(env: Env, fee_rate_bps: u32) {
        Self::require_admin(&env);
        if fee_rate_bps > MAX_FEE_RATE_BPS {
            panic_with_error!(&env, Error::FeeTooHigh);
        }
        let new_version: u64 = env
            .storage()
            .instance()
            .get::<_, u64>(&DataKey::FeeVersion)
            .unwrap_or(1)
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, Error::ArithmeticOverflow));

        env.storage().instance().set(&DataKey::FeeRate, &fee_rate_bps);
        env.storage().instance().set(&DataKey::FeeVersion, &new_version);
        env.storage().instance().extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);

        env.events()
            .publish(("FeeRateUpdated",), (fee_rate_bps, new_version));
    }

    pub fn get_fee_rate(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::FeeRate)
            .unwrap_or(0)
    }

    pub fn get_fee_version(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::FeeVersion)
            .unwrap_or(1)
    }

    /// Return the fee rate that was locked in for a specific campaign.
    pub fn get_campaign_fee_rate(env: Env, campaign_id: u64) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::CampaignFeeRateSnapshot(campaign_id))
            .unwrap_or(0)
    }

    // -----------------------------------------------------------------------
    // Campaign lifecycle
    // -----------------------------------------------------------------------

    /// Create a new campaign.
    ///
    /// Issue 1: snapshots the current `FeeRate` and `FeeVersion` into
    /// `CampaignFeeRateSnapshot` and `CampaignFeeVersion` so this campaign
    /// will never be affected by later rate changes.
    pub fn create_campaign(
        env: Env,
        creator: Address,
        token: Address,
        target_amount: i128,
        min_target: i128,
        deadline: u64,
    ) -> u64 {
        creator.require_auth();
        Self::assert_initialized(&env);

        if target_amount <= 0 || min_target <= 0 || min_target > target_amount {
            panic_with_error!(&env, Error::InvalidTarget);
        }
        let now = env.ledger().timestamp();
        if deadline <= now {
            panic_with_error!(&env, Error::InvalidDeadline);
        }
        if deadline - now > MAX_DEADLINE_SECS {
            panic_with_error!(&env, Error::DeadlineTooFar);
        }

        let mut count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::CampaignCount)
            .unwrap_or(0);
        if count == u64::MAX {
            panic_with_error!(&env, Error::ContractFull);
        }
        count = count
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, Error::ArithmeticOverflow));
        env.storage().instance().set(&DataKey::CampaignCount, &count);

        // Issue 1: snapshot fee parameters at creation time.
        let fee_rate_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FeeRate)
            .unwrap_or(0);
        let fee_version: u64 = env
            .storage()
            .instance()
            .get(&DataKey::FeeVersion)
            .unwrap_or(1);

        let campaign = Campaign {
            id: count,
            creator: creator.clone(),
            creators: Vec::new(&env),
            revenue_shares: Vec::new(&env),
            token: token.clone(),
            target_amount,
            min_target,
            deadline,
            total_raised: 0,
            status: CampaignStatus::Active,
            created_at: now,
            planter: OptionalAddress::None,
            co2_multiplier: 1,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Campaign(count), &campaign);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Campaign(count), LEDGER_THRESHOLD, LEDGER_BUMP);

        // Issue 1: persist snapshots.
        env.storage()
            .persistent()
            .set(&DataKey::CampaignFeeRateSnapshot(count), &fee_rate_bps);
        env.storage()
            .persistent()
            .set(&DataKey::CampaignFeeVersion(count), &fee_version);

        // Issue 2: initialise separate balance buckets.
        env.storage()
            .persistent()
            .set(&DataKey::SponsorBalance(count), &0i128);
        env.storage()
            .persistent()
            .set(&DataKey::FeeLiability(count), &0i128);

        env.storage().instance().extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);

        env.events().publish(
            ("CampaignCreated",),
            (
                count,
                creator,
                token,
                target_amount,
                min_target,
                deadline,
                fee_version,
                fee_rate_bps,
            ),
        );

        count
    }

    /// Contribute tokens to an active campaign.
    ///
    /// Issue 2: updates `SponsorBalance` and `FeeLiability` buckets in
    /// addition to the aggregate `total_raised` on the `Campaign`.
    ///
    /// Issue 3: check-effects-interactions — all state mutations happen before
    /// the token transfer so a re-entrant call would see the updated balances.
    pub fn contribute(env: Env, contributor: Address, campaign_id: u64, amount: i128) {
        contributor.require_auth();
        Self::assert_initialized(&env);

        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }

        let mut campaign = Self::load_campaign(&env, campaign_id);

        if campaign.status == CampaignStatus::Paused {
            panic_with_error!(&env, Error::CampaignPaused);
        }
        if campaign.status != CampaignStatus::Active {
            panic_with_error!(&env, Error::CampaignNotActive);
        }

        let new_total =
            checked_math::checked_add(&env, campaign.total_raised, amount);

        if new_total > campaign.target_amount {
            panic_with_error!(&env, Error::TargetExceeded);
        }

        // Issue 2: update sponsor balance bucket.
        let prev_sponsor: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::SponsorBalance(campaign_id))
            .unwrap_or(0);
        let new_sponsor = checked_math::checked_add(&env, prev_sponsor, amount);
        env.storage()
            .persistent()
            .set(&DataKey::SponsorBalance(campaign_id), &new_sponsor);

        // Issue 2: accrue fee liability using the campaign's locked-in rate.
        let fee_rate_bps: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::CampaignFeeRateSnapshot(campaign_id))
            .unwrap_or(0);
        let fee_amount = CheckedMath::mul_bps(amount, fee_rate_bps)
            .unwrap_or_else(|_| panic_with_error!(&env, Error::ArithmeticOverflow));
        let prev_liability: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::FeeLiability(campaign_id))
            .unwrap_or(0);
        let new_liability = checked_math::checked_add(&env, prev_liability, fee_amount);
        env.storage()
            .persistent()
            .set(&DataKey::FeeLiability(campaign_id), &new_liability);

        // Update per-contributor balance.
        let contrib_key = DataKey::Contribution(campaign_id, contributor.clone());
        let prev_contrib: i128 = env
            .storage()
            .persistent()
            .get(&contrib_key)
            .unwrap_or(0);
        let new_contrib = checked_math::checked_add(&env, prev_contrib, amount);
        env.storage().persistent().set(&contrib_key, &new_contrib);
        env.storage()
            .persistent()
            .extend_ttl(&contrib_key, LEDGER_THRESHOLD, LEDGER_BUMP);

        // Mirror gross contribution so refunds are always exact.
        let orig_key = DataKey::OriginalContribution(campaign_id, contributor.clone());
        env.storage().persistent().set(&orig_key, &new_contrib);
        env.storage()
            .persistent()
            .extend_ttl(&orig_key, LEDGER_THRESHOLD, LEDGER_BUMP);

        campaign.total_raised = new_total;

        if campaign.total_raised >= campaign.target_amount {
            campaign.status = CampaignStatus::Successful;
        }

        Self::save_campaign(&env, campaign_id, &campaign);
        Self::emit_milestones(&env, campaign_id, campaign.total_raised, campaign.target_amount);

        // Issue 3: state fully committed — now execute the token transfer.
        let token_client = token::Client::new(&env, &campaign.token);
        token_client.transfer(&contributor, &env.current_contract_address(), &amount);

        env.events().publish(
            ("ContributionMade",),
            (campaign_id, contributor, amount, campaign.total_raised),
        );
    }

    /// Trigger campaign expiry once the deadline has passed.
    pub fn trigger_expiry(env: Env, campaign_id: u64) {
        Self::assert_initialized(&env);
        let mut campaign = Self::load_campaign(&env, campaign_id);

        if env.ledger().timestamp() < campaign.deadline {
            panic_with_error!(&env, Error::DeadlineNotReached);
        }
        if campaign.status != CampaignStatus::Active {
            panic_with_error!(&env, Error::CampaignNotActive);
        }

        if campaign.total_raised >= campaign.min_target {
            campaign.status = CampaignStatus::Successful;
        } else {
            campaign.status = CampaignStatus::Failed;
        }
        Self::save_campaign(&env, campaign_id, &campaign);
    }

    /// Creator claims the raised funds after a successful campaign.
    ///
    /// Issue 2: asserts balance conservation before transferring tokens.
    /// `sponsor_balance == total_raised` and `fee_liability` is transferred to
    /// the fee collector separately.  The sum of both transfers equals
    /// `total_raised`.
    pub fn claim_funds(env: Env, campaign_id: u64) {
        Self::assert_initialized(&env);
        let mut campaign = Self::load_campaign(&env, campaign_id);
        campaign.creator.require_auth();

        if campaign.status != CampaignStatus::Successful
            && campaign.status != CampaignStatus::Verified
        {
            panic_with_error!(&env, Error::CampaignNotSuccessful);
        }

        // Issue 2: read the separate balance buckets.
        let sponsor_balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::SponsorBalance(campaign_id))
            .unwrap_or(0);
        let fee_liability: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::FeeLiability(campaign_id))
            .unwrap_or(0);

        // Issue 2: conservation invariant — sponsor funds must equal total_raised.
        if sponsor_balance != campaign.total_raised {
            panic_with_error!(&env, Error::ArithmeticOverflow);
        }

        let net_amount = CheckedMath::sub(sponsor_balance, fee_liability)
            .unwrap_or_else(|_| panic_with_error!(&env, Error::ArithmeticOverflow));

        // Issue 3: mark as claimed *before* any token transfer.
        campaign.status = CampaignStatus::Claimed;
        Self::save_campaign(&env, campaign_id, &campaign);

        // Zero out balance buckets.
        env.storage()
            .persistent()
            .set(&DataKey::SponsorBalance(campaign_id), &0i128);
        env.storage()
            .persistent()
            .set(&DataKey::FeeLiability(campaign_id), &0i128);

        let token_client = token::Client::new(&env, &campaign.token);

        // Transfer protocol fee to fee collector.
        if fee_liability > 0 {
            let fee_collector: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeCollector)
                .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
            token_client.transfer(
                &env.current_contract_address(),
                &fee_collector,
                &fee_liability,
            );
            env.events().publish(
                ("ProtocolFeeCollected",),
                (campaign_id, campaign.token.clone(), fee_collector, fee_liability),
            );
        }

        // Transfer net proceeds to creator.
        if net_amount > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &campaign.creator,
                &net_amount,
            );
        }

        env.events().publish(
            ("FundsClaimed",),
            (campaign_id, campaign.creator, net_amount),
        );
    }

    /// Contributor claims a refund from a failed campaign.
    ///
    /// Issue 3: check-effects-interactions — balance cleared before transfer.
    pub fn claim_refund(env: Env, campaign_id: u64, contributor: Address) {
        contributor.require_auth();
        Self::assert_initialized(&env);

        let campaign = Self::load_campaign(&env, campaign_id);
        if campaign.status != CampaignStatus::Failed {
            panic_with_error!(&env, Error::CampaignNotFailed);
        }

        let contrib_key = DataKey::Contribution(campaign_id, contributor.clone());
        let amount: i128 = env
            .storage()
            .persistent()
            .get(&contrib_key)
            .unwrap_or(0);
        if amount <= 0 {
            panic_with_error!(&env, Error::NoContributionFound);
        }

        // Issue 3: clear before transfer.
        env.storage().persistent().remove(&contrib_key);
        env.storage()
            .persistent()
            .remove(&DataKey::OriginalContribution(campaign_id, contributor.clone()));

        // Issue 2: reduce sponsor balance bucket.
        let prev: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::SponsorBalance(campaign_id))
            .unwrap_or(0);
        let new_bal = CheckedMath::sub(prev, amount)
            .unwrap_or_else(|_| panic_with_error!(&env, Error::ArithmeticOverflow));
        env.storage()
            .persistent()
            .set(&DataKey::SponsorBalance(campaign_id), &new_bal);

        // Also reduce fee liability proportionally.
        let fee_rate_bps: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::CampaignFeeRateSnapshot(campaign_id))
            .unwrap_or(0);
        let fee_refund = CheckedMath::mul_bps(amount, fee_rate_bps)
            .unwrap_or_else(|_| panic_with_error!(&env, Error::ArithmeticOverflow));
        let prev_liab: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::FeeLiability(campaign_id))
            .unwrap_or(0);
        let new_liab = prev_liab.saturating_sub(fee_refund).max(0);
        env.storage()
            .persistent()
            .set(&DataKey::FeeLiability(campaign_id), &new_liab);

        let token_client = token::Client::new(&env, &campaign.token);
        token_client.transfer(&env.current_contract_address(), &contributor, &amount);

        env.events()
            .publish(("RefundIssued",), (campaign_id, contributor, amount));
    }

    // -----------------------------------------------------------------------
    // Issue 3: Matching fund — atomic, no double-spend
    // -----------------------------------------------------------------------

    /// Set the matching fund for a campaign (admin only).
    ///
    /// Deposits `cap` tokens from `funder` into the contract and records
    /// them in `MatchingBalance`/`MatchingCap`.
    pub fn set_matching_fund(
        env: Env,
        campaign_id: u64,
        funder: Address,
        cap: i128,
        token: Address,
    ) {
        Self::require_admin(&env);
        funder.require_auth();

        if cap <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&funder, &env.current_contract_address(), &cap);

        env.storage()
            .persistent()
            .set(&DataKey::MatchingCap(campaign_id), &cap);
        env.storage()
            .persistent()
            .set(&DataKey::MatchingBalance(campaign_id), &cap);
        env.storage()
            .persistent()
            .set(&DataKey::MatchingUsed(campaign_id), &0i128);

        env.events()
            .publish(("MatchingFundSet",), (campaign_id, cap));
    }

    /// Claim matching for a contribution.
    ///
    /// Issue 3: `MatchingClaimUsed` flag prevents a contributor from claiming
    /// matching more than once per campaign.  The balance is decremented with
    /// a checked subtraction that panics rather than going negative.
    pub fn claim_matching(
        env: Env,
        campaign_id: u64,
        contributor: Address,
        match_amount: i128,
    ) {
        contributor.require_auth();
        Self::assert_initialized(&env);

        if match_amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }

        // Issue 3: idempotency guard.
        let used_key = DataKey::MatchingClaimUsed(campaign_id, contributor.clone());
        if env.storage().persistent().has(&used_key) {
            panic_with_error!(&env, Error::MatchingAlreadyClaimed);
        }

        // Issue 3: atomic debit from matching balance.
        let balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::MatchingBalance(campaign_id))
            .unwrap_or(0);
        let new_balance = CheckedMath::sub(balance, match_amount)
            .unwrap_or_else(|_| panic_with_error!(&env, Error::MatchingCapExceeded));

        // Mark as used BEFORE any further state change or transfer.
        env.storage().persistent().set(&used_key, &true);

        // Update consumed tracking.
        let prev_used: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::MatchingUsed(campaign_id))
            .unwrap_or(0);
        let new_used = checked_math::checked_add(&env, prev_used, match_amount);
        env.storage()
            .persistent()
            .set(&DataKey::MatchingUsed(campaign_id), &new_used);
        env.storage()
            .persistent()
            .set(&DataKey::MatchingBalance(campaign_id), &new_balance);

        // Now apply the matched contribution through the normal path.
        // (Loads campaign token, checks status, adds to total_raised, etc.)
        let campaign = Self::load_campaign(&env, campaign_id);
        let token_client = token::Client::new(&env, &campaign.token);
        // The matching fund is already in the contract; transfer directly
        // from contract to itself is a no-op but we update accounting only.
        // We increment total_raised and sponsor balance for the matched amount.
        let prev_sponsor: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::SponsorBalance(campaign_id))
            .unwrap_or(0);
        let new_sponsor = checked_math::checked_add(&env, prev_sponsor, match_amount);
        env.storage()
            .persistent()
            .set(&DataKey::SponsorBalance(campaign_id), &new_sponsor);

        let mut cam = campaign;
        cam.total_raised = checked_math::checked_add(&env, cam.total_raised, match_amount);
        if cam.total_raised >= cam.target_amount {
            cam.status = CampaignStatus::Successful;
        }
        Self::save_campaign(&env, campaign_id, &cam);

        // Avoid unused variable warning.
        let _ = token_client;

        env.events()
            .publish(("MatchingClaimed",), (campaign_id, contributor, match_amount));
    }

    // -----------------------------------------------------------------------
    // Issue 4: Scoped, revocable delegates
    // -----------------------------------------------------------------------

    /// Grant a scoped delegate allowance.
    ///
    /// The grant is indexed by `(delegator, campaign_id, nonce)` where
    /// `nonce` is the delegator's current sequence number, auto-incremented
    /// at grant time.  The delegate may only act on `campaign_id` with
    /// `token`, up to `max_amount` total, before `expiry`.
    pub fn grant_delegate(
        env: Env,
        delegator: Address,
        delegate: Address,
        campaign_id: u64,
        token: Address,
        max_amount: i128,
        expiry: u64,
    ) -> u64 {
        delegator.require_auth();

        if max_amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if expiry <= env.ledger().timestamp() {
            panic_with_error!(&env, Error::DelegateExpired);
        }

        // Issue 4: assign and increment nonce.
        let nonce_key = DataKey::DelegatorNonce(delegator.clone());
        let nonce: u64 = env
            .storage()
            .persistent()
            .get(&nonce_key)
            .unwrap_or(0)
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, Error::ArithmeticOverflow));
        env.storage().persistent().set(&nonce_key, &nonce);
        env.storage()
            .persistent()
            .extend_ttl(&nonce_key, LEDGER_THRESHOLD, LEDGER_BUMP);

        let grant = DelegateGrant {
            delegator: delegator.clone(),
            delegate: delegate.clone(),
            campaign_id,
            token: token.clone(),
            max_amount,
            remaining_amount: max_amount,
            nonce,
            expiry,
        };

        let key = DataKey::Delegate(delegator.clone(), campaign_id, nonce);
        env.storage().persistent().set(&key, &grant);
        env.storage()
            .persistent()
            .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);

        env.events().publish(
            ("DelegateGranted",),
            (delegator, delegate, campaign_id, token, max_amount, nonce, expiry),
        );

        nonce
    }

    /// Revoke an outstanding delegate grant.
    ///
    /// Issue 4: zeroes `remaining_amount` so the grant is permanently
    /// exhausted.  Anyone holding an older nonce is therefore blocked.
    pub fn revoke_delegate(env: Env, delegator: Address, campaign_id: u64, nonce: u64) {
        delegator.require_auth();

        let key = DataKey::Delegate(delegator.clone(), campaign_id, nonce);
        let mut grant: DelegateGrant = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::DelegateNotFound));

        // Zero out the allowance — permanently invalidates the grant.
        grant.remaining_amount = 0;
        env.storage().persistent().set(&key, &grant);

        env.events()
            .publish(("DelegateRevoked",), (delegator, campaign_id, nonce));
    }

    /// Execute a delegated contribution on behalf of `delegator`.
    ///
    /// Issue 4: verifies expiry, verifies the token matches the grant,
    /// verifies the amount fits within the remaining allowance, then
    /// decrements `remaining_amount` atomically before the token transfer.
    pub fn contribute_as_delegate(
        env: Env,
        delegate: Address,
        delegator: Address,
        campaign_id: u64,
        nonce: u64,
        amount: i128,
    ) {
        delegate.require_auth();

        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }

        let key = DataKey::Delegate(delegator.clone(), campaign_id, nonce);
        let mut grant: DelegateGrant = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::DelegateNotFound));

        // Issue 4: enforce expiry.
        if env.ledger().timestamp() > grant.expiry {
            panic_with_error!(&env, Error::DelegateExpired);
        }

        // Issue 4: enforce campaign binding.
        if grant.campaign_id != campaign_id {
            panic_with_error!(&env, Error::DelegateNotFound);
        }

        // Issue 4: enforce amount cap and decrement atomically.
        if amount > grant.remaining_amount {
            panic_with_error!(&env, Error::DelegateInsufficient);
        }
        grant.remaining_amount = CheckedMath::sub(grant.remaining_amount, amount)
            .unwrap_or_else(|_| panic_with_error!(&env, Error::ArithmeticOverflow));
        env.storage().persistent().set(&key, &grant);

        env.events().publish(
            ("DelegateSpent",),
            (
                delegator.clone(),
                delegate,
                campaign_id,
                amount,
                grant.remaining_amount,
            ),
        );

        // Issue 4: now execute the actual contribution under delegator's identity.
        // We load campaign state and apply contribution accounting manually so
        // the token is taken from `delegator`'s wallet (delegator.require_auth()
        // is covered by the grant — the delegate authenticated above).
        let mut campaign = Self::load_campaign(&env, campaign_id);
        if campaign.status != CampaignStatus::Active {
            panic_with_error!(&env, Error::CampaignNotActive);
        }
        let new_total = checked_math::checked_add(&env, campaign.total_raised, amount);
        if new_total > campaign.target_amount {
            panic_with_error!(&env, Error::TargetExceeded);
        }

        // Issue 4: enforce token binding.
        if grant.token != campaign.token {
            panic_with_error!(&env, Error::DelegateNotFound);
        }

        // Update accounting (effects before interactions).
        let contrib_key = DataKey::Contribution(campaign_id, delegator.clone());
        let prev: i128 = env
            .storage()
            .persistent()
            .get(&contrib_key)
            .unwrap_or(0);
        let new_contrib = checked_math::checked_add(&env, prev, amount);
        env.storage().persistent().set(&contrib_key, &new_contrib);
        env.storage()
            .persistent()
            .extend_ttl(&contrib_key, LEDGER_THRESHOLD, LEDGER_BUMP);

        let prev_sponsor: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::SponsorBalance(campaign_id))
            .unwrap_or(0);
        env.storage().persistent().set(
            &DataKey::SponsorBalance(campaign_id),
            &checked_math::checked_add(&env, prev_sponsor, amount),
        );

        campaign.total_raised = new_total;
        if campaign.total_raised >= campaign.target_amount {
            campaign.status = CampaignStatus::Successful;
        }
        Self::save_campaign(&env, campaign_id, &campaign);

        // Interaction: pull tokens from delegator.
        let token_client = token::Client::new(&env, &campaign.token);
        token_client.transfer(&delegator, &env.current_contract_address(), &amount);
    }

    /// Return a delegate grant by `(delegator, campaign_id, nonce)`.
    pub fn get_delegate_grant(
        env: Env,
        delegator: Address,
        campaign_id: u64,
        nonce: u64,
    ) -> DelegateGrant {
        env.storage()
            .persistent()
            .get(&DataKey::Delegate(delegator.clone(), campaign_id, nonce))
            .unwrap_or_else(|| panic_with_error!(&env, Error::DelegateNotFound))
    }

    // -----------------------------------------------------------------------
    // Escrow sub-system (Issue 2 + Issue 3)
    // -----------------------------------------------------------------------

    /// Initialize a campaign escrow account.
    ///
    /// Issue 2: the escrow tracks *only* sponsor funds.  Protocol fee
    /// liability is maintained in the separate `FeeLiability` bucket.
    pub fn initialize_campaign_escrow(
        env: Env,
        campaign_id: u64,
        verifier: Address,
        target_trees: u64,
    ) {
        Self::assert_initialized(&env);
        let key = DataKey::CampaignEscrow(campaign_id);
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::EscrowAlreadyInitialized);
        }

        let escrow = EscrowAccount {
            campaign_id,
            verifier,
            total_escrowed: 0,
            released_amount: 0,
            status: EscrowStatus::Held,
            is_verified: false,
            trees_planted: 0,
            target_trees,
        };
        env.storage().persistent().set(&key, &escrow);
        env.storage()
            .persistent()
            .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);
    }

    /// Deposit sponsor funds into a campaign's escrow.
    ///
    /// Issue 3: amount validation happens before the token transfer.
    pub fn deposit_to_campaign_escrow(
        env: Env,
        campaign_id: u64,
        depositor: Address,
        amount: i128,
    ) {
        depositor.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }

        let key = DataKey::CampaignEscrow(campaign_id);
        let mut escrow: EscrowAccount = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::EscrowNotInitialized));

        if escrow.status == EscrowStatus::Disputed {
            panic_with_error!(&env, Error::EscrowDisputed);
        }

        // Issue 3: update state before token transfer.
        let new_total = checked_math::checked_add(&env, escrow.total_escrowed, amount);
        escrow.total_escrowed = new_total;
        env.storage().persistent().set(&key, &escrow);
        env.storage()
            .persistent()
            .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);

        // Issue 2: also update the campaign's sponsor-balance bucket.
        let prev: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::SponsorBalance(campaign_id))
            .unwrap_or(0);
        env.storage().persistent().set(
            &DataKey::SponsorBalance(campaign_id),
            &checked_math::checked_add(&env, prev, amount),
        );

        // Obtain the token address from the campaign record.
        let campaign = Self::load_campaign(&env, campaign_id);
        let token_client = token::Client::new(&env, &campaign.token);
        token_client.transfer(&depositor, &env.current_contract_address(), &amount);
    }

    /// Verifier approves tree planting, transitioning escrow to Verified.
    pub fn approve_tree_verification(env: Env, campaign_id: u64, trees_planted: u64) {
        let key = DataKey::CampaignEscrow(campaign_id);
        let mut escrow: EscrowAccount = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::EscrowNotInitialized));

        escrow.verifier.require_auth();

        if escrow.status == EscrowStatus::Disputed {
            panic_with_error!(&env, Error::EscrowDisputed);
        }

        escrow.trees_planted = trees_planted;
        escrow.is_verified = true;
        escrow.status = EscrowStatus::Verified;
        env.storage().persistent().set(&key, &escrow);
        env.storage()
            .persistent()
            .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);
    }

    /// Release verified escrow funds to the campaign creator.
    ///
    /// Issue 2: asserts that the amount transferred equals `total_escrowed`
    /// (no silent rounding).
    ///
    /// Issue 3: status set to Released before token transfer — a failed
    /// transfer re-enters into an already-released state, which is harmless.
    pub fn release_escrow_to_creator(env: Env, campaign_id: u64) -> i128 {
        Self::assert_initialized(&env);

        let key = DataKey::CampaignEscrow(campaign_id);
        let mut escrow: EscrowAccount = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::EscrowNotInitialized));

        if !escrow.is_verified {
            panic_with_error!(&env, Error::EscrowNotVerified);
        }
        if escrow.status == EscrowStatus::Released {
            panic_with_error!(&env, Error::EscrowAlreadyReleased);
        }
        if escrow.status == EscrowStatus::Disputed {
            panic_with_error!(&env, Error::EscrowDisputed);
        }

        let amount = escrow.total_escrowed;

        // Issue 3: mark as released before transfer.
        escrow.status = EscrowStatus::Released;
        escrow.released_amount = amount;
        env.storage().persistent().set(&key, &escrow);
        env.storage()
            .persistent()
            .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);

        // Issue 2: zero the sponsor-balance bucket for this campaign.
        env.storage()
            .persistent()
            .set(&DataKey::SponsorBalance(campaign_id), &0i128);

        if amount > 0 {
            let campaign = Self::load_campaign(&env, campaign_id);
            let token_client = token::Client::new(&env, &campaign.token);
            token_client.transfer(
                &env.current_contract_address(),
                &campaign.creator,
                &amount,
            );
        }

        amount
    }

    pub fn get_campaign_escrow(env: Env, campaign_id: u64) -> EscrowAccount {
        env.storage()
            .persistent()
            .get(&DataKey::CampaignEscrow(campaign_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::EscrowNotInitialized))
    }

    // -----------------------------------------------------------------------
    // Dynamic pricing
    // -----------------------------------------------------------------------

    /// Return the current dynamic-pricing multiplier for a campaign in bps.
    ///
    /// Below 50 % funded: 1.0× (10 000 bps).
    /// 50–90 % funded: 1.1× (11 000 bps).
    /// ≥ 90 % funded: 1.5× (15 000 bps).
    pub fn get_dynamic_pricing_multiplier_bps(env: Env, campaign_id: u64) -> u32 {
        let campaign = Self::load_campaign(&env, campaign_id);
        Self::dynamic_multiplier_bps(&campaign)
    }

    /// Return the effective cost per tree given `base_cost` and current dynamic pricing.
    pub fn get_campaign_cost_per_tree(env: Env, campaign_id: u64, base_cost: i128) -> i128 {
        if base_cost <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let campaign = Self::load_campaign(&env, campaign_id);
        let multiplier = Self::dynamic_multiplier_bps(&campaign);
        CheckedMath::mul_bps(base_cost, multiplier)
            .unwrap_or_else(|_| panic_with_error!(&env, Error::ArithmeticOverflow))
    }

    /// Return how many trees a `contribution` amount buys at current pricing.
    pub fn calculate_trees_for_contribution(
        env: Env,
        campaign_id: u64,
        contribution: i128,
        base_cost: i128,
    ) -> u64 {
        if base_cost <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let campaign = Self::load_campaign(&env, campaign_id);
        let multiplier = Self::dynamic_multiplier_bps(&campaign);
        let effective_cost = CheckedMath::mul_bps(base_cost, multiplier)
            .unwrap_or_else(|_| panic_with_error!(&env, Error::ArithmeticOverflow));
        if effective_cost <= 0 {
            return 0;
        }
        (contribution / effective_cost) as u64
    }

    // -----------------------------------------------------------------------
    // Queries
    // -----------------------------------------------------------------------

    pub fn get_campaign(env: Env, campaign_id: u64) -> Campaign {
        Self::load_campaign(&env, campaign_id)
    }

    pub fn get_contribution(env: Env, campaign_id: u64, contributor: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Contribution(campaign_id, contributor))
            .unwrap_or(0)
    }

    pub fn get_campaign_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::CampaignCount)
            .unwrap_or(0)
    }

    /// Return the separate sponsor-balance bucket for a campaign (Issue 2).
    pub fn get_sponsor_balance(env: Env, campaign_id: u64) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::SponsorBalance(campaign_id))
            .unwrap_or(0)
    }

    /// Return the accrued fee-liability bucket for a campaign (Issue 2).
    pub fn get_fee_liability(env: Env, campaign_id: u64) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::FeeLiability(campaign_id))
            .unwrap_or(0)
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    // -----------------------------------------------------------------------
    // Admin setters
    // -----------------------------------------------------------------------

    pub fn set_admin(env: Env, new_admin: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);
    }

    pub fn set_fee_collector(env: Env, new_collector: Address) {
        Self::require_admin(&env);
        env.storage()
            .instance()
            .set(&DataKey::FeeCollector, &new_collector);
        env.storage().instance().extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    fn assert_initialized(env: &Env) {
        if !env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(env, Error::NotInitialized);
        }
    }

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
        admin.require_auth();
    }

    fn load_campaign(env: &Env, campaign_id: u64) -> Campaign {
        let key = DataKey::Campaign(campaign_id);
        match env.storage().persistent().get(&key) {
            Some(c) => {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);
                c
            }
            None => panic_with_error!(env, Error::CampaignNotFound),
        }
    }

    fn save_campaign(env: &Env, campaign_id: u64, campaign: &Campaign) {
        let key = DataKey::Campaign(campaign_id);
        env.storage().persistent().set(&key, campaign);
        env.storage()
            .persistent()
            .extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);
        env.storage()
            .instance()
            .extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);
    }

    fn dynamic_multiplier_bps(campaign: &Campaign) -> u32 {
        if campaign.target_amount == 0 {
            return BASE_MULTIPLIER_BPS;
        }
        let funded_bps = (campaign.total_raised * 10_000 / campaign.target_amount) as u32;
        if funded_bps >= SURGE_THRESHOLD_BPS {
            SURGE_MULTIPLIER_BPS
        } else if funded_bps >= MID_THRESHOLD_BPS {
            MID_MULTIPLIER_BPS
        } else {
            BASE_MULTIPLIER_BPS
        }
    }

    fn emit_milestones(env: &Env, campaign_id: u64, total_raised: i128, target_amount: i128) {
        if target_amount == 0 {
            return;
        }
        let pct = (total_raised * 100 / target_amount) as u32;
        let key = DataKey::MilestonesReached(campaign_id);
        let mut mask: u8 = env.storage().persistent().get(&key).unwrap_or(0u8);

        for (threshold, bit) in [(25u32, 0u8), (50, 1), (75, 2), (100, 3)] {
            if pct >= threshold && (mask & (1 << bit)) == 0 {
                mask |= 1 << bit;
                env.events().publish(
                    ("MilestoneReached",),
                    (campaign_id, threshold, total_raised, target_amount),
                );
            }
        }
        env.storage().persistent().set(&key, &mask);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env,
    };

    fn set_time(env: &Env, ts: u64) {
        env.ledger().set(LedgerInfo {
            timestamp: ts,
            protocol_version: env.ledger().protocol_version(),
            sequence_number: env.ledger().sequence(),
            network_id: Default::default(),
            base_reserve: 10,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 16,
            max_entry_ttl: 6_312_000,
        });
    }

    fn create_token<'a>(
        env: &Env,
        admin: &Address,
    ) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
        let addr = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let token = TokenClient::new(env, &addr);
        let token_admin = StellarAssetClient::new(env, &addr);
        (addr, token, token_admin)
    }

    fn setup_contract(
        env: &Env,
    ) -> (Address, CampaignFundingContractClient, Address, Address) {
        let contract_id = env.register(CampaignFundingContract, ());
        let client = CampaignFundingContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let fee_collector = Address::generate(env);
        client.initialize(&admin, &fee_collector, &250u32, &100u32);
        let token_admin = Address::generate(env);
        let (token_addr, _, _) = create_token(env, &token_admin);
        (contract_id, client, admin, token_addr)
    }

    // -----------------------------------------------------------------------
    // Campaign Escrow Tests (Issue #864)
    // -----------------------------------------------------------------------

    #[test]
    fn test_escrow_hold_and_release_upon_verifier_approval() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let verifier = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &10_000);

        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);

        // 1. Initialize escrow holding account
        client.initialize_campaign_escrow(&id, &verifier, &500);
        let escrow = client.get_campaign_escrow(&id);
        assert_eq!(escrow.status, EscrowStatus::Held);
        assert_eq!(escrow.is_verified, false);
        assert_eq!(escrow.total_escrowed, 0);

        // 2. Deposit sponsor funds into escrow
        client.deposit_to_campaign_escrow(&id, &sponsor, &5_000);
        let escrow_after = client.get_campaign_escrow(&id);
        assert_eq!(escrow_after.total_escrowed, 5_000);
        assert_eq!(escrow_after.released_amount, 0);

        // 3. Verifier approves tree planting verification
        client.approve_tree_verification(&id, &500);
        let escrow_verified = client.get_campaign_escrow(&id);
        assert_eq!(escrow_verified.is_verified, true);
        assert_eq!(escrow_verified.status, EscrowStatus::Verified);
        assert_eq!(escrow_verified.trees_planted, 500);

        // 4. Release escrow funds to creator
        let released = client.release_escrow_to_creator(&id);
        assert_eq!(released, 5_000);

        let escrow_released = client.get_campaign_escrow(&id);
        assert_eq!(escrow_released.status, EscrowStatus::Released);
        assert_eq!(escrow_released.released_amount, 5_000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #40)")]
    fn test_escrow_release_fails_if_unverified() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let verifier = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &10_000);
        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
        client.initialize_campaign_escrow(&id, &verifier, &500);
        client.deposit_to_campaign_escrow(&id, &sponsor, &5_000);

        // Cannot release funds before verification! (Panics with EscrowNotVerified #40)
        client.release_escrow_to_creator(&id);
    }

    // -----------------------------------------------------------------------
    // Escrow State Transition Edge Tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_escrow_repeated_deposits_accumulate_consistently() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let verifier = Address::generate(&env);
        let sponsor_a = Address::generate(&env);
        let sponsor_b = Address::generate(&env);

        token_admin_client.mint(&sponsor_a, &10_000);
        token_admin_client.mint(&sponsor_b, &10_000);
        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
        client.initialize_campaign_escrow(&id, &verifier, &500);

        client.deposit_to_campaign_escrow(&id, &sponsor_a, &1_000);
        client.deposit_to_campaign_escrow(&id, &sponsor_a, &2_000);
        client.deposit_to_campaign_escrow(&id, &sponsor_b, &1_500);

        let escrow = client.get_campaign_escrow(&id);
        assert_eq!(escrow.total_escrowed, 4_500);
        assert_eq!(escrow.released_amount, 0);
        assert_eq!(escrow.status, EscrowStatus::Held);
        assert_eq!(escrow.is_verified, false);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #45)")]
    fn test_escrow_double_initialize_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let creator = Address::generate(&env);
        let verifier = Address::generate(&env);
        let token = Address::generate(&env);

        let id = client.create_campaign(&creator, &token, &10_000, &5_000, &2_000);
        client.initialize_campaign_escrow(&id, &verifier, &500);
        // Second initialization must fail with EscrowAlreadyInitialized (#45).
        client.initialize_campaign_escrow(&id, &verifier, &500);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_escrow_zero_deposit_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, _) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let verifier = Address::generate(&env);
        let sponsor = Address::generate(&env);

        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
        client.initialize_campaign_escrow(&id, &verifier, &500);
        // Zero deposits are invalid (InvalidAmount #4).
        client.deposit_to_campaign_escrow(&id, &sponsor, &0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #41)")]
    fn test_escrow_double_release_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let verifier = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &10_000);
        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
        client.initialize_campaign_escrow(&id, &verifier, &500);
        client.deposit_to_campaign_escrow(&id, &sponsor, &5_000);
        client.approve_tree_verification(&id, &500);

        assert_eq!(client.release_escrow_to_creator(&id), 5_000);
        // Second release must fail with EscrowAlreadyReleased (#41).
        client.release_escrow_to_creator(&id);
    }

    #[test]
    fn test_escrow_release_state_is_stable_after_failed_retry() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let verifier = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &10_000);
        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
        client.initialize_campaign_escrow(&id, &verifier, &500);
        client.deposit_to_campaign_escrow(&id, &sponsor, &5_000);
        client.approve_tree_verification(&id, &500);
        client.release_escrow_to_creator(&id);

        // A rejected retry must not mutate escrow accounting.
        assert!(client.try_release_escrow_to_creator(&id).is_err());
        let escrow = client.get_campaign_escrow(&id);
        assert_eq!(escrow.status, EscrowStatus::Released);
        assert_eq!(escrow.total_escrowed, 5_000);
        assert_eq!(escrow.released_amount, 5_000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #44)")]
    fn test_escrow_deposit_without_initialization_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &10_000);
        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
        // No escrow initialized (EscrowNotInitialized #44).
        client.deposit_to_campaign_escrow(&id, &sponsor, &1_000);
    }

    // -----------------------------------------------------------------------
    // Dynamic Pricing Tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_dynamic_pricing_below_90_percent_uses_base_cost() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &10_000);
        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);

        // 50% funded (5,000 / 10,000) -> 1.1x (11,000 bps) intermediate tier
        client.contribute(&sponsor, &id, &5_000);
        let multiplier = client.get_dynamic_pricing_multiplier_bps(&id);
        assert_eq!(multiplier, 11_000);

        let cost = client.get_campaign_cost_per_tree(&id, &100);
        assert_eq!(cost, 110);

        let trees = client.calculate_trees_for_contribution(&id, &500, &100);
        assert_eq!(trees, 4);
    }

    #[test]
    fn test_dynamic_pricing_at_or_above_90_percent_applies_surge_multiplier() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &10_000);
        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);

        // 90% funded (9,000 / 10,000) -> 1.5x (15,000 bps) surge pricing
        client.contribute(&sponsor, &id, &9_000);
        let multiplier = client.get_dynamic_pricing_multiplier_bps(&id);
        assert_eq!(multiplier, 15_000);

        let cost = client.get_campaign_cost_per_tree(&id, &100);
        assert_eq!(cost, 150);

        let trees = client.calculate_trees_for_contribution(&id, &300, &100);
        assert_eq!(trees, 2);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_dynamic_pricing_zero_base_cost_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client, _, _) = setup_contract(&env);
        let creator = Address::generate(&env);
        let token = Address::generate(&env);

        let id = client.create_campaign(&creator, &token, &10_000, &5_000, &2_000);
        client.get_campaign_cost_per_tree(&id, &0);
    }

    // -----------------------------------------------------------------------
    // Issue 1: Versioned fee parameter tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_fee_version_increments_on_rate_change() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);

        assert_eq!(client.get_fee_version(), 1);
        client.set_fee_rate(&200u32);
        assert_eq!(client.get_fee_version(), 2);
        client.set_fee_rate(&300u32);
        assert_eq!(client.get_fee_version(), 3);
    }

    #[test]
    fn test_existing_campaign_keeps_original_fee_rate_after_global_change() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, admin, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, _) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);

        // Campaign created when fee rate is 250 bps.
        assert_eq!(client.get_fee_rate(), 250);
        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
        assert_eq!(client.get_campaign_fee_rate(&id), 250);

        // Admin changes rate to 400 bps.
        let _ = admin; // used for mock_all_auths
        client.set_fee_rate(&400u32);
        assert_eq!(client.get_fee_rate(), 400);

        // Existing campaign still uses 250 bps snapshot.
        assert_eq!(client.get_campaign_fee_rate(&id), 250);

        // New campaign gets the new rate.
        let id2 = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
        assert_eq!(client.get_campaign_fee_rate(&id2), 400);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #14)")]
    fn test_fee_rate_above_maximum_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client, _, _) = setup_contract(&env);
        // 501 bps > MAX_FEE_RATE_BPS (500) → FeeTooHigh (#14)
        client.set_fee_rate(&501u32);
    }

    // -----------------------------------------------------------------------
    // Issue 2: Balance conservation tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_sponsor_balance_and_fee_liability_track_separately() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &100_000);
        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);

        // Fee rate is 250 bps = 2.5 %.
        client.contribute(&sponsor, &id, &4_000);

        let sponsor_bal = client.get_sponsor_balance(&id);
        let fee_liab = client.get_fee_liability(&id);

        assert_eq!(sponsor_bal, 4_000);
        // 2.5 % of 4 000 = 100.
        assert_eq!(fee_liab, 100);

        // A second contribution accumulates both buckets.
        client.contribute(&sponsor, &id, &2_000);
        assert_eq!(client.get_sponsor_balance(&id), 6_000);
        // 2.5 % of 2 000 = 50; total = 150.
        assert_eq!(client.get_fee_liability(&id), 150);
    }

    #[test]
    fn test_refund_reduces_sponsor_balance_and_fee_liability() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &10_000);
        // Deadline well past 1_000 but within 180 days.
        let id = client.create_campaign(&creator, &token_addr, &10_000, &3_000, &2_000);

        client.contribute(&sponsor, &id, &1_000);
        assert_eq!(client.get_sponsor_balance(&id), 1_000);

        // Expire without reaching min target.
        set_time(&env, 3_000);
        client.trigger_expiry(&id);

        client.claim_refund(&id, &sponsor);
        assert_eq!(client.get_sponsor_balance(&id), 0);
    }

    // -----------------------------------------------------------------------
    // Issue 3: Atomic matching-fund tests
    // -----------------------------------------------------------------------

    #[test]
    #[should_panic(expected = "Error(Contract, #49)")]
    fn test_matching_claim_double_spend_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let funder = Address::generate(&env);
        let contributor = Address::generate(&env);

        token_admin_client.mint(&funder, &5_000);
        token_admin_client.mint(&contributor, &3_000);

        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
        client.contribute(&contributor, &id, &2_000);
        client.set_matching_fund(&id, &funder, &2_000, &token_addr);

        // First claim succeeds.
        client.claim_matching(&id, &contributor, &500);
        // Second claim for same contributor must fail (#49 MatchingAlreadyClaimed).
        client.claim_matching(&id, &contributor, &500);
    }

    // -----------------------------------------------------------------------
    // Issue 4: Delegate constraint tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_grant_and_use_delegate_within_allowance() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegate = Address::generate(&env);

        token_admin_client.mint(&delegator, &10_000);

        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);

        let expiry = 999_999u64;
        let nonce = client.grant_delegate(&delegator, &delegate, &id, &token_addr, &2_000, &expiry);

        let grant = client.get_delegate_grant(&delegator, &id, &nonce);
        assert_eq!(grant.max_amount, 2_000);
        assert_eq!(grant.remaining_amount, 2_000);
        assert_eq!(grant.campaign_id, id);

        // Delegate spends 500.
        client.contribute_as_delegate(&delegate, &delegator, &id, &nonce, &500);

        let updated = client.get_delegate_grant(&delegator, &id, &nonce);
        assert_eq!(updated.remaining_amount, 1_500);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #53)")]
    fn test_delegate_over_allowance_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegate = Address::generate(&env);

        token_admin_client.mint(&delegator, &10_000);

        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
        let nonce = client.grant_delegate(&delegator, &delegate, &id, &token_addr, &500, &999_999);

        // Attempt to spend 1 000 against a 500 allowance → DelegateInsufficient (#53).
        client.contribute_as_delegate(&delegate, &delegator, &id, &nonce, &1_000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #53)")]
    fn test_revoked_delegate_cannot_spend() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegate = Address::generate(&env);

        token_admin_client.mint(&delegator, &10_000);

        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
        let nonce = client.grant_delegate(&delegator, &delegate, &id, &token_addr, &2_000, &999_999);

        // Delegator revokes before any spend.
        client.revoke_delegate(&delegator, &id, &nonce);

        // Any spend against revoked grant must fail (remaining = 0 → Insufficient #53).
        client.contribute_as_delegate(&delegate, &delegator, &id, &nonce, &100);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #52)")]
    fn test_expired_delegate_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegate = Address::generate(&env);

        token_admin_client.mint(&delegator, &10_000);

        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
        // Grant expires at t=2_000.
        let nonce = client.grant_delegate(&delegator, &delegate, &id, &token_addr, &2_000, &2_000);

        // Advance time past expiry.
        set_time(&env, 3_000);
        // Should panic with DelegateExpired (#52).
        client.contribute_as_delegate(&delegate, &delegator, &id, &nonce, &100);
    }

    #[test]
    fn test_nonce_increments_per_delegator() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, _) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegate = Address::generate(&env);

        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);

        let n1 = client.grant_delegate(&delegator, &delegate, &id, &token_addr, &100, &999_999);
        let n2 = client.grant_delegate(&delegator, &delegate, &id, &token_addr, &200, &999_999);
        assert_eq!(n1, 1);
        assert_eq!(n2, 2);

        // Both grants coexist independently.
        let g1 = client.get_delegate_grant(&delegator, &id, &n1);
        let g2 = client.get_delegate_grant(&delegator, &id, &n2);
        assert_eq!(g1.max_amount, 100);
        assert_eq!(g2.max_amount, 200);
    }

    // -----------------------------------------------------------------------
    // Arithmetic audit regression tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_checked_math_audit_overflow_boundaries() {
        use crate::checked_math::CheckedMath;

        assert_eq!(
            CheckedMath::add(i128::MAX, 1),
            Err(Error::ArithmeticOverflow)
        );
        assert_eq!(
            CheckedMath::add(i128::MAX, i128::MAX),
            Err(Error::ArithmeticOverflow)
        );
        assert_eq!(CheckedMath::sub(100, 200), Err(Error::ArithmeticOverflow));
        assert_eq!(CheckedMath::sub(0, 1), Err(Error::ArithmeticOverflow));
        assert_eq!(
            CheckedMath::mul(i128::MAX / 2 + 1, 2),
            Err(Error::ArithmeticOverflow)
        );
        assert_eq!(CheckedMath::div(100, 0), Err(Error::InvalidAmount));
        assert_eq!(CheckedMath::mul_bps(0, 500), Ok(0));
        assert_eq!(CheckedMath::mul_bps(10_000, 250), Ok(250));
        assert_eq!(
            CheckedMath::mul_bps(i128::MAX, 10_000),
            Err(Error::ArithmeticOverflow)
        );
        assert_eq!(CheckedMath::validate_positive_amount(1), Ok(()));
        assert_eq!(
            CheckedMath::validate_positive_amount(0),
            Err(Error::InvalidAmount)
        );
        assert_eq!(
            CheckedMath::validate_positive_amount(-100),
            Err(Error::InvalidAmount)
        );
    }

    // -----------------------------------------------------------------------
    // Terms snapshot binding tests (Issue #176)
    // -----------------------------------------------------------------------

    #[test]
    fn test_contribute_binds_matching_terms_snapshot() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &10_000);
        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);

        let terms_hash = BytesN::from_array(&env, &[7u8; 32]);
        client.set_campaign_terms_hash(&id, &terms_hash, &1);

        client.contribute(&sponsor, &id, &1_000, &terms_hash, &1);

        assert_eq!(client.get_contribution(&id, &sponsor), 1_000);
        assert_eq!(client.get_contribution_terms_hash(&id, &sponsor), terms_hash);
        assert_eq!(client.get_contribution_terms_version(&id, &sponsor), 1);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #44)")]
    fn test_contribute_rejects_mismatched_terms_snapshot() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &10_000);
        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);

        let terms_hash = BytesN::from_array(&env, &[7u8; 32]);
        let wrong_hash = BytesN::from_array(&env, &[9u8; 32]);
        client.set_campaign_terms_hash(&id, &terms_hash, &1);

        client.contribute(&sponsor, &id, &1_000, &wrong_hash, &1);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #44)")]
    fn test_contribute_rejects_when_no_terms_snapshot_stored() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &10_000);
        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);

        let terms_hash = BytesN::from_array(&env, &[7u8; 32]);
        // No terms hash configured for the campaign -> mismatch.
        client.contribute(&sponsor, &id, &1_000, &terms_hash, &1);
    }

    #[test]
    fn test_campaign_funding_arithmetic_audit_rounding_and_units() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &100_000);
        let id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);

        // Below 50 % -> 1.0x (10 000 bps): 99 / 100 = 0 trees.
        let zero_trees = client.calculate_trees_for_contribution(&id, &99, &100);
        assert_eq!(zero_trees, 0);

        // 100 → exactly 1 tree at 1.0x.
        let one_tree = client.calculate_trees_for_contribution(&id, &199, &100);
        assert_eq!(one_tree, 1);

        // Push to 50% funded → 1.1x pricing (cost becomes 110).
        client.contribute(&sponsor, &id, &5_000);
        let cost_at_50 = client.get_campaign_cost_per_tree(&id, &100);
        assert_eq!(cost_at_50, 110);
        assert_eq!(client.calculate_trees_for_contribution(&id, &220, &100), 2);
        assert_eq!(client.calculate_trees_for_contribution(&id, &229, &100), 2);
    }
}
