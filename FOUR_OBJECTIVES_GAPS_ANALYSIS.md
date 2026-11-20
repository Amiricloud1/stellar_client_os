# Four Objectives: Current Gaps Analysis

This document maps each objective to specific gaps in the current campaign-funding contract implementation.

**Full Specification:** `/FOUR_OBJECTIVES_SPECIFICATION.md`

**Summary:** `/FOUR_OBJECTIVES_SUMMARY.md`

---

## Objective 1: Campaign Retirement & Migration

### Gap 1.1: No Retirement Lifecycle

**Current State:**
```rust
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CampaignStatus {
    Active,
    Successful,
    Verified,
    Failed,
    Claimed,
    VerificationFailed,
    Paused,
}
```

- Only tracks campaign execution state (funding, verification, claiming).
- No concept of deployment retirement or campaign archival.
- No way to transition campaign to read-only while preserving access for claims.

**Impact:**
- Campaigns remain "live" indefinitely, even if the deployment is being replaced.
- Redeploying the contract creates aliasing risk: same campaign ID could exist on multiple deployments.
- No transparent migration path for users from old to new campaigns.

**Fix:**
- Add `CampaignLifecycle` enum parallel to `CampaignStatus`.
- Lifecycle states: `Active`, `ReadOnlyMigration`, `RetiredReadOnly`, `SupersededBy(u64)`.
- Allow campaigns to transition through lifecycle states independent of funding status.

**Data Model Change:**
```rust
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CampaignLifecycle {
    Active,
    ReadOnlyMigration,
    RetiredReadOnly,
    SupersededBy(u64),
}

// New DataKey variant:
pub enum DataKey {
    // ... existing ...
    CampaignLifecycle(u64),           // NEW: per-campaign lifecycle state
    CampaignRetiredAt(u64),           // NEW: timestamp of retirement
    MigrationRetirementDeadline(u64), // NEW: deadline for migration window
}
```

---

### Gap 1.2: No Migration Metadata or Audit Trail

**Current State:**
- When a campaign ends or is claimed, there is no record of what happened to it or where users should look next.
- If a new deployment supersedes an old one, there is no chain linking them.
- No events documenting the retirement lifecycle transitions.

**Impact:**
- Off-chain systems cannot track campaign migrations.
- Users have no guidance on which campaigns to interact with after a deployment change.
- No transparent audit trail for retirement compliance.

**Fix:**
- Add events: `CampaignRetirementInitiatedEvent`, `CampaignTransitionedToRetiredEvent`, `CampaignSupersedededEvent`.
- Store audit metadata: who initiated retirement, when, deadline for migration.
- Provide `mark_superseded()` function to explicitly link old campaign to new campaign.

**New Events:**
```rust
#[contracttype]
#[derive(Clone)]
pub struct CampaignRetirementInitiatedEvent {
    pub campaign_id: u64,
    pub retirement_deadline: u64,  // Unix timestamp when automatic transition occurs
    pub initiated_by: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct CampaignSupersedededEvent {
    pub old_campaign_id: u64,
    pub new_campaign_id: u64,
    pub timestamp: u64,
}
```

---

### Gap 1.3: No Selective Operation Blocking During Retirement

**Current State:**
- `CampaignStatus::Paused` halts all operations uniformly.
- No distinction between read-only access and state-changing operations.
- Once a campaign transitions to `Claimed`, all operations that check `status == Successful` are blocked.

**Impact:**
- During migration, contributors cannot claim refunds if the campaign failed—they are locked out.
- Verifiers cannot approve verified campaigns during a retirement window.
- No way to allow historical reads while blocking new state changes.

**Fix:**
- In `ReadOnlyMigration` state: allow claims and verification, block new contributions.
- In `RetiredReadOnly` state: allow only historical reads (get_campaign, get_contributions), block all state changes.
- Guard mutations with lifecycle checks:
  ```rust
  fn contribute(...) {
      // NEW: Check lifecycle
      match get_lifecycle(campaign_id) {
          CampaignLifecycle::Active => { /* allow */ },
          CampaignLifecycle::ReadOnlyMigration => {
              panic_with_error!(&env, Error::CampaignRetired);
          },
          CampaignLifecycle::RetiredReadOnly => {
              panic_with_error!(&env, Error::CampaignRetired);
          },
          CampaignLifecycle::SupersededBy(new_id) => {
              // Emit hint to redirect; reject
              panic_with_error!(&env, Error::CampaignRetired);
          },
      }
  }
  ```

---

### Gap 1.4: No Automated Transition or Deadline Enforcement

**Current State:**
- Admin must manually manage campaign state transitions.
- No concept of a deadline or time-bound migration window.
- No mechanism to automatically transition `ReadOnlyMigration` → `RetiredReadOnly` after a deadline.

**Impact:**
- Admin overhead: manual management of retirement process.
- Risk of indefinite migration windows if admin forgets to finalize.
- No SLA enforcement for migration completion.

**Fix:**
- Store `MigrationRetirementDeadline(u64)` at retirement initiation.
- Provide `finalize_retirement()` function (stateless, callable by anyone) that transitions to `RetiredReadOnly` if deadline has passed.
- Automatic detection: Clients can poll and detect when deadlines are met.

**New Entry Points:**
```rust
pub fn initiate_retirement(
    env: Env,
    campaign_id: u64,
    deadline_in_days: u32,
) {
    // Admin only
    let deadline = env.ledger().timestamp() + deadline_in_days as u64 * 86400;
    env.storage().persistent().set(&DataKey::MigrationRetirementDeadline(campaign_id), &deadline);
    env.events().publish(..., CampaignRetirementInitiatedEvent { deadline, ... });
}

pub fn finalize_retirement(env: Env, campaign_id: u64) {
    // Anyone; deterministic state change
    let deadline: u64 = env.storage().persistent()
        .get(&DataKey::MigrationRetirementDeadline(campaign_id))
        .unwrap();
    if env.ledger().timestamp() < deadline {
        panic_with_error!(&env, Error::DeadlineNotReached);
    }
    env.storage().persistent()
        .set(&DataKey::CampaignLifecycle(campaign_id), &CampaignLifecycle::RetiredReadOnly);
}
```

---

## Objective 2: Granular Operation Pausing

### Gap 2.1: Monolithic Pause State

**Current State:**
```rust
pub enum CampaignStatus {
    // ...
    Paused,
}

// In contribute(), claim_funds(), verify_campaign(), etc.:
if campaign.status == CampaignStatus::Paused {
    panic_with_error!(&env, Error::CampaignPaused);
}
```

- A single `Paused` status halts all operations uniformly.
- No way to pause only deposits while allowing claims.
- No way to pause only payouts while allowing contributors to verify their claims.

**Impact:**
- Overly blunt instrument; affects more operations than intended.
- Risk of accidental blocking of critical operations.
- No flexibility for maintenance scenarios (e.g., pause payouts to fix issuer, keep claims open).

**Fix:**
- Replace monolithic pause with bitmask: `OperationPauseFlags`.
- Four independent bool fields: `pause_deposits`, `pause_payouts`, `pause_claims`, `pause_admin`.
- Each function checks only the flag relevant to it.

**Data Model Change:**
```rust
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct OperationPauseFlags {
    pub pause_deposits: bool,    // Block contribute()
    pub pause_payouts: bool,     // Block claim_funds()
    pub pause_claims: bool,      // Block refund_claim()
    pub pause_admin: bool,       // Block verify, dispute, assign_planter, etc.
}

// New DataKey variant:
pub enum DataKey {
    // ... existing ...
    OperationPauseFlags(u64),  // NEW: per-campaign pause bitmask
}
```

---

### Gap 2.2: No Pause Audit Trail or Reason Tracking

**Current State:**
- When a campaign is paused, there is no record of why or by whom.
- No history of pause state changes.
- No transparency on pause reasons.

**Impact:**
- Compliance risk: cannot audit why a campaign was paused.
- Operational risk: hard to troubleshoot past pause events.
- User confusion: no explanation for why operations are blocked.

**Fix:**
- Add `PauseAuditLog(u64, u32)` to track all pause state changes.
- Store each change with: timestamp, actor, old flags, new flags, reason.
- Provide `get_pause_audit_log()` query function.

**New Struct & DataKey:**
```rust
#[contracttype]
#[derive(Clone)]
pub struct PauseAuditEntry {
    pub campaign_id: u64,
    pub timestamp: u64,
    pub changed_by: Address,
    pub old_flags: OperationPauseFlags,
    pub new_flags: OperationPauseFlags,
    pub reason: soroban_sdk::String,
}

pub enum DataKey {
    // ... existing ...
    PauseAuditLog(u64, u32),  // NEW: audit log entries
}
```

---

### Gap 2.3: No Fund-Redirection Prevention

**Current State:**
- If payouts are paused, admin could theoretically:
  1. Pause payouts.
  2. Approve a verifier dispute that redirects funds to themselves.
  3. Unpause payouts.
  4. Claim funds now routed to a different address.
- No guard against this misuse.

**Impact:**
- Trust risk: Admin could abuse pause mechanism to redirect funds.
- No separation of concerns: pause power includes fund-redirection power.

**Fix:**
- Add invariant: If `pause_payouts == true`, then `pause_admin == true` (mandatory).
- Rationale: If payouts are frozen, all fund-moving operations (including disputes) must also be frozen.
- Enforce in `set_operation_pause_flags()`:
  ```rust
  if flags.pause_payouts && !flags.pause_admin {
      panic_with_error!(&env, Error::PauseConfigurationInvalid);
  }
  ```

**New Error:**
```rust
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // ... existing ...
    PauseConfigurationInvalid = 50,  // NEW
}
```

---

### Gap 2.4: Per-Operation Mutations Lack Pause Checks

**Current State:**
- `contribute()` checks `campaign.status == Paused`.
- `claim_funds()` checks `campaign.status == Paused`.
- Other operations may not check pause state at all.
- No systematic guard pattern.

**Impact:**
- Inconsistent behavior across operations.
- Easy to forget a pause check when adding new operations.
- No clear separation of which pause flag affects which operation.

**Fix:**
- Add guards to every state-mutating entry point:
  ```rust
  fn contribute(...) {
      let flags = get_pause_flags(campaign_id);
      if flags.pause_deposits {
          panic_with_error!(&env, Error::DepositsPaused);
      }
      // ... rest of function
  }
  
  fn claim_funds(...) {
      let flags = get_pause_flags(campaign_id);
      if flags.pause_payouts {
          panic_with_error!(&env, Error::PayoutsPaused);
      }
      // ... rest of function
  }
  
  fn refund_claim(...) {
      let flags = get_pause_flags(campaign_id);
      if flags.pause_claims {
          panic_with_error!(&env, Error::ClaimsPaused);
      }
      // ... rest of function
  }
  
  fn verify_campaign(...) {
      let flags = get_pause_flags(campaign_id);
      if flags.pause_admin {
          panic_with_error!(&env, Error::AdminOperationsPaused);
      }
      // ... rest of function
  }
  ```

---

## Objective 3: Network & Deployment Binding

### Gap 3.1: No Network Context in Contract

**Current State:**
```rust
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Campaign(u64),
    Contribution(u64, Address),
    // ... all keys use campaign ID alone, no network context
}
```

- Contract stores no network identifier.
- Campaign IDs are allocated sequentially within the contract.
- No binding between campaign and network.

**Impact:**
- If the contract is redeployed to a different network (testnet → mainnet), the same campaign ID space exists on both.
- A malicious actor could redeploy the contract to mainnet, copy campaign data from testnet, and claim to be the canonical deployment.
- Off-chain systems have no way to verify which deployment is canonical.

**Fix:**
- Add `DeploymentIdentity` struct capturing: `contract_address`, `network_id`, `deployment_version`, `initialized_at`.
- Set on `initialize()` based on a parameter.
- Store in instance storage (immutable after initialization).

**New Struct & DataKey:**
```rust
#[contracttype]
#[derive(Clone)]
pub struct DeploymentIdentity {
    pub contract_address: Address,        // env.current_contract_address()
    pub network_id: soroban_sdk::String,  // e.g., "mainnet", "testnet-soroban"
    pub initialized_at: u64,              // env.ledger().timestamp()
    pub deployment_version: u64,          // e.g., 1, 2, 3 for successive deployments
}

pub enum DataKey {
    // ... existing ...
    DeploymentIdentity,  // NEW: immutable deployment metadata
}
```

---

### Gap 3.2: Campaigns Not Bound to Network or Deployment

**Current State:**
```rust
#[contracttype]
#[derive(Clone)]
pub struct Campaign {
    pub id: u64,
    pub creator: Address,
    pub token: Address,
    pub target_amount: i128,
    // ... no deployment_id or network_id field
}
```

- Campaign struct has no reference to the deployment or network where it was created.
- Historical campaigns cannot be verified as belonging to the canonical deployment.

**Impact:**
- If a contract is redeployed, there is no way to know whether a campaign comes from the old or new deployment.
- Aliasing risk: redeployed contract could claim campaigns from old deployment.

**Fix:**
- Add two new fields to `Campaign`:
  - `deployment_id: u64` — snapshot of deployment's `deployment_version` at creation.
  - `network_id: soroban_sdk::String` — snapshot of deployment's `network_id` at creation.
- Set these fields at campaign creation time via `create_campaign()`.

**Data Model Change:**
```rust
#[contracttype]
#[derive(Clone)]
pub struct Campaign {
    pub id: u64,
    pub creator: Address,
    // ... existing fields ...
    pub deployment_id: u64,        // NEW: set at creation
    pub network_id: soroban_sdk::String,  // NEW: set at creation
}
```

---

### Gap 3.3: No Lookup Verification Guards

**Current State:**
- When looking up a campaign via `get_campaign()` or `contribute()`, there is no check that the campaign belongs to the current deployment or network.
- Any contract on any network could claim to have the campaign data.

**Impact:**
- A malicious redeployment to a different network could claim campaigns from the original deployment.
- Users could be tricked into interacting with a fake campaign on a different network.

**Fix:**
- Add a guard function `assert_same_network_and_deployment()` that verifies:
  ```rust
  fn assert_same_network_and_deployment(
      env: &Env,
      campaign: &Campaign,
  ) {
      let deployment: DeploymentIdentity = env.storage()
          .instance()
          .get(&DataKey::DeploymentIdentity)
          .unwrap();
      
      if campaign.network_id != deployment.network_id {
          panic_with_error!(env, Error::NetworkMismatch);
      }
      if campaign.deployment_id != deployment.deployment_version {
          panic_with_error!(env, Error::DeploymentMismatch);
      }
  }
  ```
- Call this guard in every state-changing operation and most queries.

**New Error Codes:**
```rust
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // ... existing ...
    NetworkMismatch = 51,      // NEW: campaign network differs
    DeploymentMismatch = 52,   // NEW: campaign deployment differs
}
```

---

### Gap 3.4: No initialize() Parameter for Network

**Current State:**
```rust
pub fn initialize(
    env: Env,
    admin: Address,
    fee_collector: Address,
    general_fee_rate: u32,
) {
    // ... no network_id parameter
}
```

- Network identity is not captured at initialization.
- Subsequent deployments have no way to specify their intended network.

**Impact:**
- Operator error: cannot explicitly bind deployment to a network.
- Ambiguity: when querying contract data, cannot verify network affinity.

**Fix:**
- Extend `initialize()` signature to accept `network_id` and `deployment_version`:
  ```rust
  pub fn initialize(
      env: Env,
      admin: Address,
      fee_collector: Address,
      general_fee_rate: u32,
      network_id: soroban_sdk::String,      // NEW
      deployment_version: u64,              // NEW
  ) {
      let deployment = DeploymentIdentity {
          contract_address: env.current_contract_address(),
          network_id,
          initialized_at: env.ledger().timestamp(),
          deployment_version,
      };
      env.storage()
          .instance()
          .set(&DataKey::DeploymentIdentity, &deployment);
  }
  ```

---

## Objective 4: Asset Metadata & Risk Management

### Gap 4.1: No Asset Metadata Registry

**Current State:**
```rust
#[contracttype]
#[derive(Clone)]
pub struct Campaign {
    pub token: Address,  // Just the token address, no metadata
    // ... no issuer info, no review status, no verification
}
```

- Campaign stores only the token contract address.
- No record of the token issuer, asset code, or verification status.
- No way to look up what token an address represents.

**Impact:**
- Users cannot verify which organization issued a token.
- No centralized registry of approved or flagged assets.
- No way to warn users about at-risk tokens.

**Fix:**
- Add `AssetMetadata` struct capturing:
  - `asset_code` — human-readable identifier (e.g., "USDC").
  - `issuer_account` — Stellar issuer (if applicable).
  - `issuer_name` — organization name.
  - `issuer_verification_url` — link to transparency document.
  - `review_status` — approval/risk status.
  - `last_review_timestamp` — when status was last reviewed.
  - `last_reviewed_by` — which admin set the status.
  - `canonical_network_id` — network this asset is intended for.
- Provide `register_asset_metadata()` to add assets to the registry.

**New Struct & DataKey:**
```rust
#[contracttype]
#[derive(Clone)]
pub struct AssetMetadata {
    pub token_address: Address,
    pub asset_code: soroban_sdk::String,
    pub issuer_account: soroban_sdk::String,
    pub issuer_name: soroban_sdk::String,
    pub issuer_verification_url: soroban_sdk::String,
    pub review_status: AssetReviewStatus,
    pub last_review_timestamp: u64,
    pub last_reviewed_by: Address,
    pub canonical_network_id: soroban_sdk::String,
}

pub enum DataKey {
    // ... existing ...
    AssetMetadata(Address),  // NEW: keyed by token address
}
```

---

### Gap 4.2: No Asset Review Status Tracking

**Current State:**
- Contracts do not distinguish between verified and unverified assets.
- No way to mark an asset as "approved", "flagged", or "deprecated".
- No audit trail of asset review decisions.

**Impact:**
- Campaigns can be funded with unvetted or compromised assets.
- No way to warn users about risks associated with an asset.
- No way to prevent use of deprecated assets.

**Fix:**
- Add `AssetReviewStatus` enum: `Unreviewed`, `Approved`, `Flagged`, `Deprecated`.
- Provide `update_asset_review_status()` to change status with audit trail.
- Provide `AssetReviewHistory` to log all status changes.

**New Enum & DataKey:**
```rust
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AssetReviewStatus {
    Unreviewed,
    Approved,
    Flagged,
    Deprecated,
}

pub enum DataKey {
    // ... existing ...
    AssetReviewHistory(Address, u32),  // NEW: audit log of status changes
}
```

---

### Gap 4.3: No Risk Flag or Issue Tracking

**Current State:**
- When an asset becomes compromised (e.g., issuer hacked, smart contract bug), there is no way to record the issue or recommend remediation.
- No way to track multiple independent issues with an asset.

**Impact:**
- Users are unaware of known problems.
- No audit trail of when issues were discovered or resolved.
- Campaigns funded with at-risk assets cannot be flagged for monitoring.

**Fix:**
- Add `AssetRiskFlag` struct capturing:
  - `flag_reason` — description of the issue.
  - `flagged_at` — timestamp.
  - `flagged_by` — which admin flagged it.
  - `estimated_severity` — 1-10 scale.
  - `remediation_info` — suggested action (e.g., "migrate to USDC").
- Provide `raise_asset_risk_flag()` and `clear_asset_risk_flag()` to manage flags.
- Provide `AssetRiskFlags` storage to maintain history.

**New Struct & DataKey:**
```rust
#[contracttype]
#[derive(Clone)]
pub struct AssetRiskFlag {
    pub token_address: Address,
    pub flag_reason: soroban_sdk::String,
    pub flagged_at: u64,
    pub flagged_by: Address,
    pub estimated_severity: u32,       // 1-10
    pub remediation_info: soroban_sdk::String,
}

pub enum DataKey {
    // ... existing ...
    AssetRiskFlags(Address, u32),     // NEW: per-token, paginated
    AssetRiskFlagCount(Address),      // NEW: count of active flags
}
```

---

### Gap 4.4: No Token Status Snapshot in Campaign

**Current State:**
- Campaign stores only `token: Address`.
- No record of the token's review status at the time the campaign was created.
- If an asset is later flagged or deprecated, historical campaigns have no way to show they were funded with an at-risk asset.

**Impact:**
- Cannot audit historical risk: was a campaign funded with a flagged token?
- Users see current asset status, not status at campaign creation.
- No way to track impact of asset degradation on existing campaigns.

**Fix:**
- Add `token_review_status: AssetReviewStatus` field to `Campaign`.
- Set at campaign creation time to snapshot the token's current review status.
- Provide `get_campaign_token_status()` query that returns both creation-time and current status.

**Data Model Change:**
```rust
#[contracttype]
#[derive(Clone)]
pub struct Campaign {
    // ... existing fields ...
    pub token_review_status: AssetReviewStatus,  // NEW: snapshot at creation
}

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

---

### Gap 4.5: No State Guards on Asset Deprecation

**Current State:**
- When creating a campaign with `create_campaign()`, there is no check on the token's review status.
- Campaigns can be funded with `Deprecated` or `Flagged` tokens without warning.

**Impact:**
- Users accidentally fund campaigns with compromised assets.
- No opportunity to warn or prevent.

**Fix:**
- In `create_campaign()`: reject if token review status is `Deprecated`.
- In `contribute()`: allow if `Flagged`, but emit warning event.
- Provide `CampaignCreatedWithUnreviewedTokenEvent` when token is not registered.

**New Guards:**
```rust
fn create_campaign(
    env: Env,
    creator: Address,
    token: Address,
    target_amount: i128,
    min_target: i128,
    deadline: u64,
) -> u64 {
    // ... existing checks ...
    
    // NEW: Check token status
    if let Some(metadata) = get_asset_metadata(&env, &token) {
        if metadata.review_status == AssetReviewStatus::Deprecated {
            panic_with_error!(&env, Error::TokenDeprecated);
        }
    }
    
    // ... create campaign and capture review_status snapshot ...
    let review_status = get_asset_metadata(&env, &token)
        .map(|m| m.review_status)
        .unwrap_or(AssetReviewStatus::Unreviewed);
    
    campaign.token_review_status = review_status;
    // ... store campaign ...
}

fn contribute(
    env: Env,
    contributor: Address,
    campaign_id: u64,
    amount: i128,
) {
    let campaign = get_campaign(&env, campaign_id);
    
    // NEW: Check token status
    if let Some(metadata) = get_asset_metadata(&env, &campaign.token) {
        if metadata.review_status == AssetReviewStatus::Deprecated {
            panic_with_error!(&env, Error::TokenDeprecated);
        }
        if metadata.review_status == AssetReviewStatus::Flagged {
            env.events().publish(
                ("ContributionMadeToFlaggedToken", campaign_id),
                ContributionMadeToFlaggedTokenEvent { ... },
            );
        }
    }
    
    // ... rest of contribute ...
}
```

---

## Summary of Current Gaps vs. Fixes

| Gap | Objective | Current State | Fix |
|-----|-----------|---------------|-----|
| No retirement lifecycle | 1 | Campaign stuck in funding state forever | Add `CampaignLifecycle` enum; transitions; migration deadline |
| No migration metadata | 1 | Redeployments are not linked | Add `mark_superseded()`; events; audit trail |
| No selective op blocking | 1 | Paused state halts all ops | Allow claims/verify in `ReadOnlyMigration`, only reads in `RetiredReadOnly` |
| No automated transitions | 1 | Manual admin work to finalize | `finalize_retirement()` callable by anyone after deadline |
| Monolithic pause | 2 | Single `Paused` status | Bitmask `OperationPauseFlags` with 4 independent flags |
| No pause audit trail | 2 | No transparency on why campaigns are paused | `PauseAuditLog` with timestamps, actor, reason |
| Fund redirection risk | 2 | Admin can pause payouts then redirect funds | Invariant: `pause_payouts ⟹ pause_admin` |
| Inconsistent pause checks | 2 | Per-function pause checking, easy to miss | Systematic guards; new error codes per operation |
| No network context | 3 | Contract stores no network ID | `DeploymentIdentity` struct; set on `initialize()` |
| Campaigns not bound to network | 3 | No `deployment_id` or `network_id` in campaign | Add fields to `Campaign`; set at creation |
| No lookup verification | 3 | Any contract on any network can claim campaigns | `assert_same_network_and_deployment()` guard |
| No network parameter in `initialize()` | 3 | Cannot specify deployment network | Extend `initialize()` signature |
| No asset metadata registry | 4 | No record of issuer, asset code, approval status | `AssetMetadata` struct; `register_asset_metadata()` |
| No asset review status | 4 | Cannot mark assets as approved/flagged/deprecated | `AssetReviewStatus` enum; `update_asset_review_status()` |
| No risk tracking | 4 | Unknown issues with assets | `AssetRiskFlag` struct; `raise_asset_risk_flag()` |
| No status snapshot | 4 | Cannot audit historical token risk | Add `token_review_status` to campaign; snapshot at creation |
| No asset deprecation guards | 4 | Campaigns can use deprecated tokens | Reject on creation; warn on contribution |

---

## References

- **Full Specification:** `/FOUR_OBJECTIVES_SPECIFICATION.md`
- **Summary:** `/FOUR_OBJECTIVES_SUMMARY.md`
- **Current Contract:** `/contracts/campaign-funding/src/lib.rs` (1167 lines)
- **Related:** `/contracts/payment-stream/src/lib.rs` (pause pattern reference)

