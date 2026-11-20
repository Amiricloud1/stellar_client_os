# Stellar Campaign Funding Contract: Four Objectives Specification

**Purpose:** This document provides a detailed technical architecture specification for fixing four critical objectives in the campaign-funding contract. Each objective addresses a distinct data model, authorization, and contract interaction gap.

**Scope:** All analysis is restricted to `/contracts/campaign-funding/src/lib.rs` and its interactions with related contracts (payment-stream, distributor, planter, etc.). This spec does not cover implementation details, only the structural and architectural requirements.

---

## Objective 1: Retire Deployments While Preserving Claims, Historical Reads, and Transparent Migration Choices

### Current State

**Data Model:**
- `Campaign` struct (line 248): Contains immutable campaign metadata with a single `id: u64`.
- `CampaignStatus` enum (line 200): Has states `Active`, `Successful`, `Verified`, `Failed`, `Claimed`, `VerificationFailed`, `Paused`.
- `DataKey` enum (line 123): Uses `Campaign(u64)` keyed only by campaign ID, with no deployment or version context.

**Storage Patterns:**
- Campaign metadata stored at `DataKey::Campaign(u64)` (persistent).
- Contributions stored at `DataKey::Contribution(u64, Address)` (persistent).
- Status history at `DataKey::StatusHistory(u64, u32)` (persistent).

**Current Gaps:**
1. **No retirement concept:** Once a campaign exists, there is no way to mark it as retired without breaking historical reads.
2. **No deployment binding:** The same campaign ID can hypothetically exist across different contract deployments, creating aliasing risk.
3. **No migration metadata:** There is no tracking of which campaign is superseded by which, making audit trails opaque.
4. **No readonly-after-retirement:** Retired campaigns cannot be selectively opened for view-only access (e.g., for claims processing).

### Required Fixes

#### 1.1 New Enum: `CampaignLifecycle`

Add to the contract to separate campaign execution state from deployment retirement state:

```
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CampaignLifecycle {
    /// Campaign is active within the deployment and follows normal status transitions.
    Active,
    /// Campaign is still funded and callable, but the deployment is being retired.
    /// New contributions are blocked; claims and verification reads are still allowed.
    ReadOnlyMigration,
    /// Campaign is fully retired and cannot accept state changes.
    /// Only historical reads (claims, contributions, status history) are available.
    RetiredReadOnly,
    /// Campaign has been explicitly marked as replaced by another campaign ID.
    /// Lookups should redirect to the replacement campaign.
    SupersededBy(u64),  // replacement campaign ID
}
```

**Rationale:**
- `Active` is the current normal state; operations proceed unchanged.
- `ReadOnlyMigration` signals that the deployment itself is being retired, but the campaign remains claimable and verifiable during a defined migration window (e.g., 90 days).
- `RetiredReadOnly` means the campaign and its data are archived; no new transactions allowed.
- `SupersededBy` explicitly documents which campaign ID users should query instead, enabling transparent client-side migration.

#### 1.2 Data Model Changes

**In `DataKey` enum (line 123):**
- Add: `CampaignLifecycle(u64)` — stores the current lifecycle state for each campaign.
- Add: `CampaignRetiredAt(u64)` — Unix timestamp when a campaign transitioned to `ReadOnlyMigration` or `RetiredReadOnly`.
- Add: `MigrationRetirementDeadline(u64)` — Unix timestamp after which `ReadOnlyMigration` automatically transitions to `RetiredReadOnly`.

**In `Campaign` struct (line 248):**
- No breaking changes needed; the struct remains the canonical campaign metadata.
- The lifecycle and migration state live in separate storage keys to allow independent mutation.

**New Events:**
```rust
#[contracttype]
#[derive(Clone)]
pub struct CampaignRetirementInitiatedEvent {
    pub campaign_id: u64,
    pub retirement_deadline: u64,  // timestamp when ReadOnlyMigration → RetiredReadOnly
    pub initiated_by: Address,     // admin who triggered retirement
}

#[contracttype]
#[derive(Clone)]
pub struct CampaignTransitionedToRetiredEvent {
    pub campaign_id: u64,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct CampaignSupersedededEvent {
    pub old_campaign_id: u64,
    pub new_campaign_id: u64,
    pub timestamp: u64,
}
```

#### 1.3 Contract Function Signatures

**New entry points:**

1. **`initiate_retirement(campaign_id: u64, deadline_in_days: u32)`**
   - Caller: Admin only (via `require_auth`).
   - Preconditions: 
     - Campaign exists and is in `Active` status.
     - `deadline_in_days` is in range [1, 365].
   - Postconditions:
     - `CampaignLifecycle(campaign_id)` → `ReadOnlyMigration`.
     - `MigrationRetirementDeadline(campaign_id)` → `current_ledger_time + deadline_in_days * 86400`.
     - Emits `CampaignRetirementInitiatedEvent`.
   - Effect: Campaign is frozen from accepting new contributions; all other operations (verify, claim, refund, history reads) remain available.

2. **`finalize_retirement(campaign_id: u64)`**
   - Caller: Anyone (no auth required, state is deterministic).
   - Preconditions:
     - Campaign lifecycle is `ReadOnlyMigration`.
     - Current ledger time >= `MigrationRetirementDeadline(campaign_id)`.
   - Postconditions:
     - `CampaignLifecycle(campaign_id)` → `RetiredReadOnly`.
     - `CampaignRetiredAt(campaign_id)` → current ledger time.
     - Emits `CampaignTransitionedToRetiredEvent`.
   - Effect: Campaign enters full archive mode; no state-changing operations allowed.

3. **`mark_superseded(old_campaign_id: u64, new_campaign_id: u64)`**
   - Caller: Admin only.
   - Preconditions:
     - Old campaign exists and is in `RetiredReadOnly` or `ReadOnlyMigration`.
     - New campaign exists and is in `Active` lifecycle.
   - Postconditions:
     - `CampaignLifecycle(old_campaign_id)` → `SupersededBy(new_campaign_id)`.
     - Emits `CampaignSupersedededEvent`.
   - Effect: Historical lookups on old campaign can optionally redirect to new campaign.

4. **`get_campaign_lifecycle(campaign_id: u64) → CampaignLifecycle`**
   - Query function; returns current lifecycle state.
   - Preconditions: None (defensive; returns a default state if not found).
   - Effect: Clients can check whether a campaign is active, in migration, retired, or superseded.

#### 1.4 State Mutation Guards

**In `contribute()` (existing):**
- Add check: If `CampaignLifecycle(campaign_id)` is anything other than `Active`, reject with new error `CampaignRetired` (e.g., error code 45).
- Current: No such check; contributions are allowed even if the deployment is being retired.

**In `claim_funds()` (existing):**
- Add guard: Allow if lifecycle is `Active` OR `ReadOnlyMigration`.
- Reject if lifecycle is `RetiredReadOnly` (error: `CampaignRetired`).
- Reject if lifecycle is `SupersededBy(...)` with hint to query the replacement campaign.

**In `trigger_expiry()`, `verify_campaign()`, etc. (existing):**
- Similar guards: Allow read-only operations in all states; block state changes in `RetiredReadOnly` and `SupersededBy`.

#### 1.5 Contract Interaction Impact

**Campaign Funding ↔ Payment Stream:**
- Payment stream integration (reward streams for contributors) must check campaign lifecycle before creating a stream.
- If campaign is `ReadOnlyMigration` or `RetiredReadOnly`, payment stream creation should be rejected or emit a deprecation warning.

**Campaign Funding ↔ Carbon Credits / Tax Certificates:**
- These downstream systems should query campaign lifecycle before minting or issuing.
- Existing data (already-minted credits, issued certificates) remain valid; new issuance is blocked for retired campaigns.

**Off-chain indexing (SDK, mobile, web):**
- Clients must track `CampaignRetirementInitiatedEvent` and `CampaignSupersedededEvent`.
- Upon retirement initiation, clients can show a migration deadline warning.
- Upon supersedence, clients can transparently redirect queries to the new campaign ID.

---

## Objective 2: Separate Pausing Deposits, Payouts, Claims, and Administration Without Granting Fund-Redirection Authority

### Current State

**Data Model:**
- `CampaignStatus::Paused` (line 200): A single pause state that halts all operations uniformly.
- `DataKey::Paused` in payment-stream contract (payment-stream/src/lib.rs): A global emergency pause, not per-campaign.

**Authorization:**
- Campaign creator and admin both have broad permissions; no granular pause-per-operation-type.
- `claim_funds()` checks `status == Successful` without distinguishing between "paused" and "blocked."

**Current Gaps:**
1. **Monolithic pause:** If a campaign is paused, all operations halt indiscriminately.
2. **No selective fund blocking:** Cannot pause payouts without also pausing claims or vice versa.
3. **No administration pause:** Cannot pause admin actions (e.g., verifier approval) independently.
4. **Risk of fund redirection:** If pause is misused, admin could suspend payouts, then re-route funds, leading to loss of creator control.

### Required Fixes

#### 2.1 New Enum: `OperationPauseFlags`

Add a bitmask to track pause state per operation type:

```rust
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct OperationPauseFlags {
    pub pause_deposits: bool,    // Block contribute()
    pub pause_payouts: bool,     // Block claim_funds() and team payouts
    pub pause_claims: bool,      // Block refund_claim() specifically
    pub pause_admin: bool,       // Block verify_campaign(), resolve_dispute(), etc.
}
```

**Rationale:**
- Each flag controls a distinct operation category.
- Bitmask allows independent control without a monolithic "paused" state.
- Serializes as a compact `struct` in storage.

#### 2.2 New Error Codes

Add to the `Error` enum (line 667):

```rust
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // ... existing errors ...
    /// Deposits are currently paused for this campaign.
    DepositsPaused = 46,
    /// Payouts are currently paused for this campaign.
    PayoutsPaused = 47,
    /// Claims/refunds are currently paused for this campaign.
    ClaimsPaused = 48,
    /// Admin operations are currently paused for this campaign.
    AdminOperationsPaused = 49,
    /// Cannot pause fund operations without also pausing admin operations
    /// (to prevent fund redirection during pause).
    PauseConfigurationInvalid = 50,
}
```

#### 2.3 Data Model Changes

**In `DataKey` enum (line 123):**
- Replace `Paused` (if a per-campaign pause is stored) with: `OperationPauseFlags(u64)` — stores the bitmask for each campaign.
- Add: `PauseAuditLog(u64, u32)` — indexed audit log of pause state changes, keyed by campaign ID and sequence number.

**In `Campaign` struct (line 248):**
- No change needed; pause flags live in separate storage to allow independent mutation without re-serializing the whole campaign.

**New Struct: `PauseAuditEntry`**

```rust
#[contracttype]
#[derive(Clone)]
pub struct PauseAuditEntry {
    pub campaign_id: u64,
    pub timestamp: u64,
    pub changed_by: Address,
    pub old_flags: OperationPauseFlags,
    pub new_flags: OperationPauseFlags,
    pub reason: soroban_sdk::String,  // Optional explanation (e.g., "Suspected fraud")
}
```

**New Events:**

```rust
#[contracttype]
#[derive(Clone)]
pub struct OperationPauseChangedEvent {
    pub campaign_id: u64,
    pub pause_deposits: bool,
    pub pause_payouts: bool,
    pub pause_claims: bool,
    pub pause_admin: bool,
    pub changed_by: Address,
    pub timestamp: u64,
}
```

#### 2.4 Contract Function Signatures

**New entry points:**

1. **`set_operation_pause_flags(campaign_id: u64, flags: OperationPauseFlags, reason: String)`**
   - Caller: Admin only.
   - Preconditions:
     - Campaign exists.
     - `flags` passes validation (see below).
   - Postconditions:
     - `OperationPauseFlags(campaign_id)` → `flags`.
     - Appends audit entry to `PauseAuditLog(campaign_id, ...)`.
     - Emits `OperationPauseChangedEvent`.
   - Effect: Selectively pauses/unpauses each operation type.

2. **`get_operation_pause_flags(campaign_id: u64) → OperationPauseFlags`**
   - Query function; returns current pause state.
   - Preconditions: None.
   - Effect: Clients can check which operations are paused.

3. **`get_pause_audit_log(campaign_id: u64, start_idx: u32, limit: u32) → Vec<PauseAuditEntry>`**
   - Query function; returns paginated audit log.
   - Preconditions: None.
   - Effect: Full transparency on all pause state changes, including who changed it and why.

#### 2.5 Pause Validation Logic

**Invariant: Fund Redirection Prevention**

```
If (pause_payouts == true) then (pause_admin == true) MUST hold.
```

**Rationale:** If payouts are paused but admin operations are not, an admin could approve a verifier dispute and redirect funds to themselves. By requiring `pause_admin == true` whenever `pause_payouts == true`, we ensure that no fund-moving operations can occur while payouts are frozen.

**Implementation in `set_operation_pause_flags()`:**

```rust
if flags.pause_payouts && !flags.pause_admin {
    panic_with_error!(&env, Error::PauseConfigurationInvalid);
}
```

#### 2.6 State Mutation Guards

**In `contribute()` (existing):**
- Add check: If `OperationPauseFlags(campaign_id).pause_deposits == true`, reject with error `DepositsPaused`.

**In `claim_funds()` (existing):**
- Add check: If `OperationPauseFlags(campaign_id).pause_payouts == true`, reject with error `PayoutsPaused`.

**In `refund_claim()` (existing):**
- Add check: If `OperationPauseFlags(campaign_id).pause_claims == true`, reject with error `ClaimsPaused`.

**In `verify_campaign()`, `resolve_dispute()`, `assign_planter()`, etc. (existing):**
- Add check: If `OperationPauseFlags(campaign_id).pause_admin == true`, reject with error `AdminOperationsPaused`.

#### 2.7 Contract Interaction Impact

**Campaign Funding ↔ Payment Stream:**
- Payment stream's `deposit()` should check campaign pause flags before accepting a stream deposit that depends on a campaign's status.
- If campaign has `pause_payouts`, payment stream should not be allowed to complete reward streams for that campaign.

**Campaign Funding ↔ Escrow (Issue #864):**
- Escrow release (line 1000 in lib.rs, `release_escrow_to_creator()`) must check `pause_payouts` before releasing funds.
- If `pause_admin == true`, escrow initialization and tree verification are blocked.

**Off-chain indexing:**
- Clients must track `OperationPauseChangedEvent` to update pause state in real-time.
- Mobile and web must disable deposit, claim, and verification UIs based on pause flags.

---

## Objective 3: Include Network and Deployment Identity in Lookups So Redeployments Cannot Alias Historical Campaigns

### Current State

**Data Model:**
- Campaign ID is a u64 assigned sequentially within a contract (line 248, `id: u64`).
- No network context: The contract does not store or check which network (testnet, mainnet, staging) it is deployed to.
- No deployment address: The contract does not include its own address in campaign lookups.

**Storage Patterns:**
- Campaigns keyed by ID alone: `DataKey::Campaign(u64)` (line 123).
- Contributions keyed by campaign ID and contributor: `DataKey::Contribution(u64, Address)` (line 123).

**Current Gaps:**
1. **No network binding:** A contract redeployed to a different network could reuse the same campaign ID and claim historical data.
2. **No deployment address in key:** Campaigns are not bound to the specific contract instance that created them.
3. **No canonical lookup:** A client cannot verify that a campaign lookup is actually from the correct deployment.
4. **Aliasing risk:** A malicious redeployment could alias legitimate campaign data if ID allocation is not strictly managed.

### Required Fixes

#### 3.1 New Struct: `DeploymentIdentity`

Add a struct to uniquely identify the current deployment and network:

```rust
#[contracttype]
#[derive(Clone, Eq, PartialEq)]
pub struct DeploymentIdentity {
    /// Address of this contract instance (set at initialization).
    pub contract_address: Address,
    /// Network identifier string (e.g., "testnet-soroban", "mainnet", "staging-soroban").
    /// Set via initialize() based on a parameter.
    pub network_id: soroban_sdk::String,
    /// Unix timestamp when this deployment was initialized.
    pub initialized_at: u64,
    /// Deterministic deployment version counter (incremented on each deployment).
    /// External systems (off-chain) must track this to detect redeployments.
    pub deployment_version: u64,
}
```

**Rationale:**
- `contract_address` makes it impossible for a different deployment to claim the same campaign.
- `network_id` binds campaigns to their intended network; a campaign created on testnet cannot be queried from mainnet.
- `initialized_at` serves as a timestamp anchor for audit and forensic purposes.
- `deployment_version` allows off-chain systems to detect and react to redeployments.

#### 3.2 Data Model Changes

**In `DataKey` enum (line 123):**
- Add: `DeploymentIdentity` — stores the unique identity of this contract deployment (instance storage).

**In `Campaign` struct (line 248):**
- Add new field: `pub deployment_id: u64` — captures the `deployment_version` at the time the campaign was created.
- Add new field: `pub network_id: soroban_sdk::String` — captures the network ID at creation time.

**New Events:**

```rust
#[contracttype]
#[derive(Clone)]
pub struct DeploymentInitializedEvent {
    pub contract_address: Address,
    pub network_id: soroban_sdk::String,
    pub initialized_at: u64,
    pub deployment_version: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct NetworkMismatchDetectedEvent {
    pub expected_network_id: soroban_sdk::String,
    pub received_network_id: soroban_sdk::String,
    pub timestamp: u64,
}
```

#### 3.3 Contract Function Signatures

**Modified entry point:**

1. **`initialize(admin: Address, fee_collector: Address, general_fee_rate: u32, network_id: String, deployment_version: u64)`**
   - Caller: Not yet initialized (check `DeploymentIdentity` absent).
   - Preconditions:
     - `network_id` is a valid string (non-empty, <= 64 bytes, ASCII alphanumeric + hyphens).
     - `deployment_version` is >= 1.
   - Postconditions:
     - `DeploymentIdentity` is stored with `contract_address = env.current_contract_address()`, `network_id = network_id`, `initialized_at = env.ledger().timestamp()`, `deployment_version = deployment_version`.
     - Emits `DeploymentInitializedEvent`.
   - Effect: Records the unique identity of this deployment.

**New entry points:**

1. **`get_deployment_identity() → DeploymentIdentity`**
   - Query function; returns the stored deployment identity.
   - Preconditions: None.
   - Effect: Clients can verify they are querying the correct deployment.

2. **`verify_campaign_network(campaign_id: u64, expected_network_id: String) → bool`**
   - Query function; checks whether a campaign's network matches the expected network.
   - Preconditions: Campaign exists.
   - Postconditions: Returns `true` if `campaign.network_id == expected_network_id`, else `false`.
   - Effect: Clients can defensively verify network affinity before trusting campaign data.

#### 3.4 Storage Key Reformat

**Current (vulnerable to aliasing):**
```
DataKey::Campaign(u64)              // Just the campaign ID
DataKey::Contribution(u64, Address) // Just campaign ID + contributor
```

**New (bound to deployment identity):**
```
// The lookup tuple now includes deployment version and network ID:
// This ensures no cross-network or cross-deployment aliasing.

// Option A (implicit, via DeploymentIdentity check):
// - Always check DeploymentIdentity before any campaign lookup.
// - If network_id or deployment_version mismatches, reject the lookup.

// Option B (explicit, via composite key):
// - Change DataKey to include deployment context in the key itself.
// DataKey::Campaign { id: u64, network_id: String, deployment_version: u64 }
```

**Recommendation: Use Option A (implicit check)**
- Simpler to implement and audit (no key format change).
- Every lookup is guarded by a centralized `assert_same_network_and_deployment()` function.

#### 3.5 Lookup Guard Function

**Add to contract:**

```rust
fn assert_same_network_and_deployment(
    env: &Env,
    campaign: &Campaign,
    expected_network_id: &soroban_sdk::String,
) -> Result<(), Error> {
    let deployment: DeploymentIdentity = env.storage()
        .instance()
        .get(&DataKey::DeploymentIdentity)
        .ok_or(Error::NotInitialized)?;
    
    if campaign.network_id != deployment.network_id {
        panic_with_error!(env, Error::NetworkMismatch);  // new error code
    }
    if campaign.deployment_id != deployment.deployment_version {
        panic_with_error!(env, Error::DeploymentMismatch);  // new error code
    }
    if expected_network_id != &deployment.network_id {
        panic_with_error!(env, Error::NetworkMismatch);
    }
    Ok(())
}
```

#### 3.6 State Mutation Guards

**In `contribute()`, `claim_funds()`, `get_campaign()`, etc.:**
- Add call: `self::assert_same_network_and_deployment(&env, &campaign, &expected_network_id)?`
- Effect: All lookups verify network and deployment affinity before returning data.

**New error codes (add to `Error` enum):**

```rust
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // ... existing ...
    /// Campaign belongs to a different network.
    NetworkMismatch = 51,
    /// Campaign belongs to a different deployment version.
    DeploymentMismatch = 52,
}
```

#### 3.7 Contract Interaction Impact

**Campaign Funding ↔ Payment Stream:**
- Payment stream deposits must verify that the stream's campaign matches the expected deployment and network.
- On stream creation, store the deployment_id and network_id in the stream metadata.

**Campaign Funding ↔ Carbon Credits / Tax Certificates:**
- These contracts should store and check the campaign's deployment_id and network_id before issuing credits or certificates.
- On migration to a new deployment, certificates must be reissued with the new deployment context.

**Off-chain indexing (SDK, mobile, web):**
- Clients must query `get_deployment_identity()` on initialization and cache the `deployment_version` and `network_id`.
- All campaign lookups should pass `expected_network_id` to verify network affinity.
- On deployment change (detected by `deployment_version` increment), clients should invalidate their cache and re-fetch all campaign data.

---

## Objective 4: Bind Assets to Canonical Network Identifiers and Expose Review, Retirement, and Issuer-Risk Status

### Current State

**Data Model:**
- `Campaign` struct (line 248): Stores `token: Address` (the token contract).
- No canonical network identifier for the token.
- No asset metadata: No issuer, verified status, or risk flags.
- No asset review history: No way to track when an asset was vetted or flagged.

**Related Contracts:**
- `carbon-credit` tokens minted per campaign (line 669, `CarbonCreditsMintedEvent`).
- No central registry of which tokens are verified or at risk.

**Current Gaps:**
1. **No canonical token binding:** A token address alone does not guarantee it is the intended asset; it could be a malicious fork or wrapped asset.
2. **No issuer risk tracking:** No way to flag tokens issued by at-risk organizations or smart contracts.
3. **No asset review status:** No way to mark tokens as audited, pending review, or flagged.
4. **No retirement for assets:** If a token is compromised, there is no way to deprecate it across campaigns.

### Required Fixes

#### 4.1 New Enum: `AssetReviewStatus`

```rust
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AssetReviewStatus {
    /// Asset has not been formally reviewed; campaigns using it are at unknown risk.
    Unreviewed,
    /// Asset has been audited by the security team and approved for campaigns.
    Approved,
    /// Asset has been flagged for issues (e.g., issuer bankruptcy, smart contract bug).
    /// Campaigns using this asset are at elevated risk and should be marked for monitoring.
    Flagged,
    /// Asset has been deprecated and should not be used for new campaigns.
    Deprecated,
}
```

**Rationale:**
- Unreviewed is the default; new assets are not auto-approved.
- Approved means a human or DAO has vetted the asset and issuer.
- Flagged means the asset remains active but has known issues; campaigns can continue, but users should be warned.
- Deprecated means no new campaigns can use this asset.

#### 4.2 New Struct: `AssetMetadata`

```rust
#[contracttype]
#[derive(Clone)]
pub struct AssetMetadata {
    /// Token contract address on the current network.
    pub token_address: Address,
    /// Human-readable canonical asset code (e.g., "USDC", "EURC", "custom-carbon-token").
    pub asset_code: soroban_sdk::String,
    /// Stellar issuer account (if this is a Stellar asset; empty string if not applicable).
    pub issuer_account: soroban_sdk::String,
    /// Descriptive name of the issuer organization or smart contract.
    pub issuer_name: soroban_sdk::String,
    /// URL to the issuer's transparency/verification document (optional).
    pub issuer_verification_url: soroban_sdk::String,
    /// Current review status of this asset and issuer.
    pub review_status: AssetReviewStatus,
    /// Unix timestamp of the last review or status change.
    pub last_review_timestamp: u64,
    /// Address of the admin/reviewer who last changed the status.
    pub last_reviewed_by: Address,
    /// Network identifier this asset is canonical on (e.g., "mainnet", "testnet-soroban").
    pub canonical_network_id: soroban_sdk::String,
}
```

**Rationale:**
- `asset_code` and `issuer_account` provide human-readable identifiers for off-chain audit.
- `issuer_verification_url` points to a published audit or issuer disclosure.
- `review_status` allows campaigns to query asset risk at a glance.
- `canonical_network_id` ensures the asset definition is bound to the correct network.

#### 4.3 New Struct: `AssetRiskFlag`

```rust
#[contracttype]
#[derive(Clone)]
pub struct AssetRiskFlag {
    pub token_address: Address,
    pub flag_reason: soroban_sdk::String,  // e.g., "Issuer under regulatory investigation"
    pub flagged_at: u64,
    pub flagged_by: Address,
    pub estimated_severity: u32,           // 1-10 scale; 10 = critical
    pub remediation_info: soroban_sdk::String,  // e.g., "Recommended to migrate to USDC"
}
```

#### 4.4 Data Model Changes

**In `DataKey` enum (line 123):**
- Add: `AssetMetadata(Address)` — stores asset metadata keyed by token address (instance storage).
- Add: `AssetRiskFlags(Address, u32)` — stores a list of active risk flags, keyed by token address and sequence number (persistent storage).
- Add: `AssetRiskFlagCount(Address)` — count of risk flags for each token (instance storage).
- Add: `AssetReviewHistory(Address, u32)` — audit log of review status changes (persistent storage).

**In `Campaign` struct (line 248):**
- Add new field: `pub token_review_status: AssetReviewStatus` — snapshot of the token's review status at campaign creation time.
- This field is immutable; it records what the risk profile was when the campaign was funded.

**New Events:**

```rust
#[contracttype]
#[derive(Clone)]
pub struct AssetMetadataRegisteredEvent {
    pub token_address: Address,
    pub asset_code: soroban_sdk::String,
    pub issuer_name: soroban_sdk::String,
    pub review_status: AssetReviewStatus,
    pub registered_by: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct AssetReviewStatusChangedEvent {
    pub token_address: Address,
    pub old_status: AssetReviewStatus,
    pub new_status: AssetReviewStatus,
    pub changed_by: Address,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct AssetRiskFlagRaisedEvent {
    pub token_address: Address,
    pub flag_reason: soroban_sdk::String,
    pub severity: u32,
    pub flagged_by: Address,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct AssetRiskFlagClearedEvent {
    pub token_address: Address,
    pub flag_reason: soroban_sdk::String,
    pub cleared_by: Address,
    pub timestamp: u64,
}
```

#### 4.5 Contract Function Signatures

**New entry points:**

1. **`register_asset_metadata(metadata: AssetMetadata)`**
   - Caller: Admin only.
   - Preconditions:
     - Token address is not already registered.
     - `canonical_network_id` matches the current deployment's network ID.
     - `asset_code` and `issuer_name` are non-empty and <= 128 bytes.
   - Postconditions:
     - `AssetMetadata(token_address)` is stored.
     - Emits `AssetMetadataRegisteredEvent`.
   - Effect: Registers an asset as an approved or auditable token for campaigns.

2. **`update_asset_review_status(token_address: Address, new_status: AssetReviewStatus, reason: String)`**
   - Caller: Admin only.
   - Preconditions:
     - Asset is registered.
     - `new_status` differs from the current status.
   - Postconditions:
     - `AssetMetadata(token_address).review_status` → `new_status`.
     - Appends audit entry to `AssetReviewHistory(token_address, ...)`.
     - Emits `AssetReviewStatusChangedEvent`.
   - Effect: Updates the approval status of an asset.

3. **`raise_asset_risk_flag(token_address: Address, reason: String, severity: u32, remediation_info: String)`**
   - Caller: Admin or designated risk monitor.
   - Preconditions:
     - Asset is registered.
     - `severity` is in range [1, 10].
     - `reason` is non-empty and <= 256 bytes.
   - Postconditions:
     - New `AssetRiskFlag` is appended to `AssetRiskFlags(token_address, ...)`.
     - `AssetRiskFlagCount(token_address)` is incremented.
     - Emits `AssetRiskFlagRaisedEvent`.
   - Effect: Records a known issue or risk with the asset.

4. **`clear_asset_risk_flag(token_address: Address, flag_index: u32)`**
   - Caller: Admin only.
   - Preconditions:
     - Risk flag at `flag_index` exists for the token.
   - Postconditions:
     - Flag is marked as resolved (soft-delete, not removed; history is preserved).
     - Emits `AssetRiskFlagClearedEvent`.
   - Effect: Records resolution of a previously flagged risk.

5. **`get_asset_metadata(token_address: Address) → Option<AssetMetadata>`**
   - Query function; returns asset metadata if registered.
   - Preconditions: None.
   - Effect: Clients can check an asset's issuer, review status, and network affinity.

6. **`get_asset_risk_flags(token_address: Address, start_idx: u32, limit: u32) → Vec<AssetRiskFlag>`**
   - Query function; returns paginated risk flags.
   - Preconditions: None.
   - Effect: Clients can review all known issues with an asset.

7. **`get_campaign_token_status(campaign_id: u64) → Option<CampaignTokenStatus>`**
   - Query function; returns combined token and campaign risk data.
   - Postconditions: Returns struct containing:
     - `token_address: Address`
     - `asset_metadata: Option<AssetMetadata>`
     - `review_status_at_creation: AssetReviewStatus` (from campaign snapshot)
     - `current_review_status: AssetReviewStatus` (current asset status)
     - `active_risk_flags: Vec<AssetRiskFlag>`
     - `timestamp_queried: u64`
   - Effect: Clients get a complete picture of token risk for a given campaign.

**New struct (return type for `get_campaign_token_status()`):**

```rust
#[contracttype]
#[derive(Clone)]
pub struct CampaignTokenStatus {
    pub campaign_id: u64,
    pub token_address: Address,
    pub asset_metadata: Option<AssetMetadata>,
    pub review_status_at_creation: AssetReviewStatus,
    pub current_review_status: AssetReviewStatus,
    pub active_risk_flags: Vec<AssetRiskFlag>,
    pub timestamp_queried: u64,
}
```

#### 4.6 State Mutation Guards

**In `create_campaign()`:**
- Add check: If token is registered and `review_status == Deprecated`, reject with new error `TokenDeprecated`.
- If token is not registered, allow creation but emit a warning event: `CampaignCreatedWithUnreviewedTokenEvent`.
- Snapshot the current `review_status` into the campaign's `token_review_status` field at creation time.

**In `contribute()`:**
- Query current `AssetMetadata(campaign.token).review_status`.
- If status is `Deprecated`, reject with error `TokenDeprecated`.
- If status is `Flagged`, allow contribution but emit warning event: `ContributionMadeToFlaggedTokenEvent`.

**In `claim_funds()`:**
- Query current `AssetMetadata(campaign.token).review_status`.
- If `Flagged`, allow claim but emit warning event: `FundClaimedForFlaggedTokenEvent`.
- Log the claim action for audit purposes.

#### 4.7 New Error Codes

Add to the `Error` enum (line 667):

```rust
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // ... existing ...
    /// Asset has been deprecated and cannot be used for new campaigns.
    TokenDeprecated = 53,
    /// Asset metadata already registered for this token.
    AssetAlreadyRegistered = 54,
    /// Asset metadata not found; asset has not been reviewed.
    AssetNotRegistered = 55,
    /// Risk flag severity must be in range [1, 10].
    InvalidRiskSeverity = 56,
}
```

#### 4.8 Contract Interaction Impact

**Campaign Funding ↔ Carbon Credit Minting:**
- Before minting carbon credits (line 669), check campaign's `token_review_status`.
- If token was flagged at campaign creation, emit a warning that carbon credits were minted from a flagged-token campaign.
- Store the token review status snapshot in the carbon credit contract as well.

**Campaign Funding ↔ Tax Deduction Certificates:**
- Before issuing tax certificates, check campaign's `token_review_status`.
- If flagged, issue the certificate but mark it with a disclaimer.

**Campaign Funding ↔ Payment Stream:**
- Payment stream deposits should query campaign token status and reject deposits if the token is deprecated or critically flagged.

**Off-chain indexing (SDK, mobile, web):**
- Cache `AssetMetadata` for all known tokens locally.
- On each campaign query, compare the stored `token_review_status_at_creation` with the current `current_review_status` to detect asset degradation.
- Display risk warnings on campaign pages if the token has active risk flags.
- On `AssetReviewStatusChangedEvent` (e.g., token moved from Approved → Flagged), update the UI immediately and notify users of affected campaigns.

---

## Cross-Objective Interactions

### Data Model Dependency Graph

```
DeploymentIdentity (Obj 3)
  └─→ Campaign
       ├─→ CampaignLifecycle (Obj 1)
       ├─→ OperationPauseFlags (Obj 2)
       ├─→ TokenReviewStatus (Obj 4)
       │    └─→ AssetMetadata (Obj 4)
       │         └─→ AssetRiskFlags (Obj 4)
       └─→ Contribution
            └─→ (inherits deployment + network checks from Campaign)
```

### Authorization Matrix

| Operation | Admin Required? | Paused by? | Blocked by Lifecycle? | Network Check? |
|-----------|-----------------|------------|----------------------|----------------|
| `contribute()` | No | `pause_deposits` | `ReadOnlyMigration`, `RetiredReadOnly`, `SupersededBy` | Yes |
| `claim_funds()` | No | `pause_payouts` | `RetiredReadOnly`, `SupersededBy` | Yes |
| `refund_claim()` | No | `pause_claims` | `ReadOnlyMigration`, `RetiredReadOnly`, `SupersededBy` | Yes |
| `verify_campaign()` | No | `pause_admin` | `ReadOnlyMigration`, `RetiredReadOnly`, `SupersededBy` | Yes |
| `initiate_retirement()` | Yes | N/A | Requires `Active` | Yes |
| `finalize_retirement()` | No | N/A | Requires `ReadOnlyMigration` | Yes |
| `mark_superseded()` | Yes | N/A | Requires `RetiredReadOnly` or `ReadOnlyMigration` | Yes |
| `set_operation_pause_flags()` | Yes | N/A | None | Yes |
| `register_asset_metadata()` | Yes | N/A | None | Yes |
| `update_asset_review_status()` | Yes | N/A | None | Yes |

### Error Code Summary

| Objective | Error Code | Name | When Triggered |
|-----------|-----------|------|---|
| 1 | 45 | `CampaignRetired` | Lifecycle is `RetiredReadOnly` or `SupersededBy` on state-changing op. |
| 2 | 46 | `DepositsPaused` | `pause_deposits == true` in `contribute()`. |
| 2 | 47 | `PayoutsPaused` | `pause_payouts == true` in `claim_funds()`. |
| 2 | 48 | `ClaimsPaused` | `pause_claims == true` in `refund_claim()`. |
| 2 | 49 | `AdminOperationsPaused` | `pause_admin == true` in verify/dispute ops. |
| 2 | 50 | `PauseConfigurationInvalid` | `pause_payouts && !pause_admin`. |
| 3 | 51 | `NetworkMismatch` | Campaign network differs from expected. |
| 3 | 52 | `DeploymentMismatch` | Campaign deployment version differs. |
| 4 | 53 | `TokenDeprecated` | Asset status is `Deprecated`. |
| 4 | 54 | `AssetAlreadyRegistered` | Attempt to register already-registered asset. |
| 4 | 55 | `AssetNotRegistered` | Attempt to query unregistered asset (optional check). |
| 4 | 56 | `InvalidRiskSeverity` | Severity not in [1, 10]. |

---

## Testing & Verification Strategy

### Unit Tests Per Objective

**Objective 1 (Retirement):**
- Verify `Active` → `ReadOnlyMigration` transition on `initiate_retirement()`.
- Verify automatic `ReadOnlyMigration` → `RetiredReadOnly` on deadline.
- Verify `RetiredReadOnly` blocks `contribute()`, allows `claim_funds()` in correct window.
- Verify `mark_superseded()` creates `SupersededBy` and redirects queries.

**Objective 2 (Pause Flags):**
- Verify each pause flag independently blocks its operation.
- Verify invariant: `pause_payouts ⟹ pause_admin` is enforced.
- Verify pause audit log captures all changes with timestamps and reasons.
- Verify unpausing allows operations to resume.

**Objective 3 (Deployment Identity):**
- Verify `DeploymentIdentity` is set on `initialize()` and immutable thereafter.
- Verify campaigns created store correct `network_id` and `deployment_id`.
- Verify cross-network lookups are rejected with `NetworkMismatch`.
- Verify cross-deployment lookups are rejected with `DeploymentMismatch`.

**Objective 4 (Asset Metadata):**
- Verify asset registration stores metadata correctly.
- Verify review status updates propagate to `CampaignTokenStatus` queries.
- Verify risk flags are appended and queryable.
- Verify `create_campaign()` rejects `Deprecated` tokens.
- Verify `contribute()` allows but warns on `Flagged` tokens.

### Integration Tests Across Objectives

- Verify that a retired campaign with flagged token is correctly marked and auditable.
- Verify that a paused campaign prevents contributions but allows claims and verifications per pause flags.
- Verify that redeployment to a new network cannot alias campaigns from the old network.

---

## Migration & Deployment Considerations

### Backward Compatibility

- **No breaking changes to `Campaign` struct storage key:** Existing campaigns remain queryable via `DataKey::Campaign(u64)`.
- **New fields in `Campaign` struct:** Add `deployment_id` and `network_id` as new fields; old campaigns will have default values (0 and empty string, respectively).
- **Additive storage keys:** All new `DataKey` variants are additions; no existing keys are removed or redefined.

### Off-Chain Integration (SDK, Mobile, Web)

1. **Deployment Identity Cache:**
   - On app startup, fetch `get_deployment_identity()` and cache the network ID and deployment version.
   - On network change (e.g., user switches from testnet to mainnet), invalidate cache and re-fetch.

2. **Retirement & Migration Tracking:**
   - Subscribe to `CampaignRetirementInitiatedEvent` and `CampaignSupersedededEvent`.
   - Show countdown to retirement deadline in UI.
   - On supersedence, transparently redirect campaign queries to new ID.

3. **Pause State Monitoring:**
   - Subscribe to `OperationPauseChangedEvent`.
   - Disable deposit UI if `pause_deposits == true`.
   - Disable claim UI if `pause_claims == true`.
   - Show reason from pause audit log in UI.

4. **Asset Risk Awareness:**
   - Cache `AssetMetadata` for all registered tokens.
   - On each campaign query, compare campaign's `token_review_status_at_creation` with current status.
   - Display risk disclaimers if token is `Flagged` or `Deprecated`.
   - Subscribe to `AssetReviewStatusChangedEvent` to detect degradation in real-time.

### Deployment Process

1. **Pre-deployment:** Define `network_id` and `deployment_version` for the target network (e.g., `"mainnet"`, version `1`).
2. **Deployment:** Call `initialize()` with these parameters.
3. **Post-deployment (if migrating from old deployment):**
   - For each campaign on the old deployment, create a corresponding campaign on the new deployment.
   - Call `mark_superseded(old_campaign_id, new_campaign_id)` on the old contract to record the migration.
   - Off-chain systems detect supersedence events and redirect user queries.

---

## Summary of Structural Changes

### New Types (Enums, Structs)

| Type | Location | Purpose |
|------|----------|---------|
| `CampaignLifecycle` | Obj 1 | Track campaign retirement state (Active, ReadOnlyMigration, RetiredReadOnly, SupersededBy). |
| `OperationPauseFlags` | Obj 2 | Bitmask for selective operation pausing (deposits, payouts, claims, admin). |
| `PauseAuditEntry` | Obj 2 | Audit log entry for pause state changes. |
| `DeploymentIdentity` | Obj 3 | Unique identity of contract deployment (address, network, timestamp, version). |
| `AssetReviewStatus` | Obj 4 | Asset approval status (Unreviewed, Approved, Flagged, Deprecated). |
| `AssetMetadata` | Obj 4 | Asset information (code, issuer, review status, network binding). |
| `AssetRiskFlag` | Obj 4 | Known risk or issue with an asset. |
| `CampaignTokenStatus` | Obj 4 | Combined query result: campaign + token + risk info. |

### New DataKey Variants

| Key | Storage Class | Purpose |
|-----|----------------|---------|
| `CampaignLifecycle(u64)` | Persistent | Lifecycle state per campaign. |
| `CampaignRetiredAt(u64)` | Persistent | Timestamp of retirement transition. |
| `MigrationRetirementDeadline(u64)` | Persistent | Deadline for ReadOnlyMigration → RetiredReadOnly. |
| `OperationPauseFlags(u64)` | Persistent | Pause bitmask per campaign. |
| `PauseAuditLog(u64, u32)` | Persistent | Pause change audit entries. |
| `DeploymentIdentity` | Instance | Current deployment's unique identity. |
| `AssetMetadata(Address)` | Instance | Asset info keyed by token address. |
| `AssetRiskFlags(Address, u32)` | Persistent | Risk flags keyed by token and index. |
| `AssetRiskFlagCount(Address)` | Instance | Count of risk flags per token. |
| `AssetReviewHistory(Address, u32)` | Persistent | Audit log of review status changes. |

### New Entry Points

**Objective 1:**
- `initiate_retirement(campaign_id, deadline_in_days)`
- `finalize_retirement(campaign_id)`
- `mark_superseded(old_campaign_id, new_campaign_id)`
- `get_campaign_lifecycle(campaign_id) → CampaignLifecycle`

**Objective 2:**
- `set_operation_pause_flags(campaign_id, flags, reason)`
- `get_operation_pause_flags(campaign_id) → OperationPauseFlags`
- `get_pause_audit_log(campaign_id, start_idx, limit) → Vec<PauseAuditEntry>`

**Objective 3:**
- `initialize(admin, fee_collector, fee_rate, network_id, deployment_version)` (modified signature)
- `get_deployment_identity() → DeploymentIdentity`
- `verify_campaign_network(campaign_id, expected_network_id) → bool`

**Objective 4:**
- `register_asset_metadata(metadata)`
- `update_asset_review_status(token_address, new_status, reason)`
- `raise_asset_risk_flag(token_address, reason, severity, remediation_info)`
- `clear_asset_risk_flag(token_address, flag_index)`
- `get_asset_metadata(token_address) → Option<AssetMetadata>`
- `get_asset_risk_flags(token_address, start_idx, limit) → Vec<AssetRiskFlag>`
- `get_campaign_token_status(campaign_id) → Option<CampaignTokenStatus>`

### New Events

| Event | Objective | Emitted by |
|-------|-----------|-----------|
| `CampaignRetirementInitiatedEvent` | 1 | `initiate_retirement()` |
| `CampaignTransitionedToRetiredEvent` | 1 | `finalize_retirement()` |
| `CampaignSupersedededEvent` | 1 | `mark_superseded()` |
| `OperationPauseChangedEvent` | 2 | `set_operation_pause_flags()` |
| `DeploymentInitializedEvent` | 3 | `initialize()` |
| `NetworkMismatchDetectedEvent` | 3 | `verify_campaign_network()` (on mismatch) |
| `AssetMetadataRegisteredEvent` | 4 | `register_asset_metadata()` |
| `AssetReviewStatusChangedEvent` | 4 | `update_asset_review_status()` |
| `AssetRiskFlagRaisedEvent` | 4 | `raise_asset_risk_flag()` |
| `AssetRiskFlagClearedEvent` | 4 | `clear_asset_risk_flag()` |

### New Error Codes

Codes 45–56 (see error code summary above).

---

## References

- **Current contract:** `/contracts/campaign-funding/src/lib.rs`
- **Checked math lib:** `/contracts/campaign-funding/src/checked_math.rs`
- **Payment stream (reference for pause patterns):** `/contracts/payment-stream/src/lib.rs`
- **Distributor (reference for audit logging):** `/contracts/distributor/src/lib.rs`
- **Audit document:** `/docs/audits/contract-security-remediation.md`
- **Campaign architecture:** `/CAMPAIGN_CONTRACT_ARCHITECTURE.md`

