# Four Objectives: Executive Summary & Reference

This document summarizes the four objectives and provides quick navigation to the full specification.

**Full Specification:** See `/FOUR_OBJECTIVES_SPECIFICATION.md`

---

## Quick Reference

### Objective 1: Campaign Retirement & Migration
**File:** `/FOUR_OBJECTIVES_SPECIFICATION.md#objective-1`

**Problem:** Once deployed, campaigns cannot be retired while preserving historical access. Redeployments risk aliasing old campaign data.

**Solution:**
- Add `CampaignLifecycle` enum with states: `Active`, `ReadOnlyMigration`, `RetiredReadOnly`, `SupersededBy(u64)`.
- Admin can initiate retirement with a migration deadline.
- Campaigns can be marked as superseded by a new campaign ID.
- Historical reads (claims, verification) remain available during migration window.

**New Functions:**
| Function | Returns | Purpose |
|----------|---------|---------|
| `initiate_retirement(id, days)` | void | Start retirement process with deadline |
| `finalize_retirement(id)` | void | Transition from ReadOnlyMigration → RetiredReadOnly |
| `mark_superseded(old_id, new_id)` | void | Mark old campaign replaced by new |
| `get_campaign_lifecycle(id)` | CampaignLifecycle | Query current lifecycle state |

**Key Invariant:**
- `Active` campaigns accept all operations (contribute, claim, verify).
- `ReadOnlyMigration` campaigns accept claims and verification, block new contributions.
- `RetiredReadOnly` campaigns block all state changes; only historical reads allowed.
- `SupersededBy(new_id)` campaigns should redirect queries to the new ID.

---

### Objective 2: Granular Operation Pausing
**File:** `/FOUR_OBJECTIVES_SPECIFICATION.md#objective-2`

**Problem:** A single "paused" state halts all operations. No way to pause payouts without also pausing claims. Risk of fund redirection if admin pauses payouts and then manipulates verifier decisions.

**Solution:**
- Add `OperationPauseFlags` struct with four independent bool fields:
  - `pause_deposits` — block `contribute()`
  - `pause_payouts` — block `claim_funds()` and team payouts
  - `pause_claims` — block `refund_claim()`
  - `pause_admin` — block verify, dispute, planter assignment, etc.
- Enforce invariant: If `pause_payouts == true`, then `pause_admin == true` (prevents fund redirection).
- Maintain audit log of all pause state changes with timestamps, actor, and reason.

**New Functions:**
| Function | Returns | Purpose |
|----------|---------|---------|
| `set_operation_pause_flags(id, flags, reason)` | void | Set pause bitmask with audit entry |
| `get_operation_pause_flags(id)` | OperationPauseFlags | Query current pause state |
| `get_pause_audit_log(id, start, limit)` | Vec\<PauseAuditEntry\> | Retrieve pause change history |

**Key Invariant:**
```
if pause_payouts then pause_admin  // Prevents fund redirection
```

---

### Objective 3: Network & Deployment Binding
**File:** `/FOUR_OBJECTIVES_SPECIFICATION.md#objective-3`

**Problem:** Campaign IDs are not bound to a specific network or deployment. A contract redeployed to a different network could claim the same campaign ID and alias historical data.

**Solution:**
- Add `DeploymentIdentity` struct capturing:
  - `contract_address` — this deployment's contract address
  - `network_id` — network name (e.g., "mainnet", "testnet-soroban")
  - `initialized_at` — deployment timestamp
  - `deployment_version` — version counter for redeployment tracking
- Store `network_id` and `deployment_id` in each `Campaign` at creation time.
- Guard all lookups to verify network and deployment affinity.

**New Functions:**
| Function | Returns | Purpose |
|----------|---------|---------|
| `initialize(admin, fee, rate, network_id, deployment_ver)` | void | Initialize with network/deployment context |
| `get_deployment_identity()` | DeploymentIdentity | Query current deployment's identity |
| `verify_campaign_network(id, expected_network)` | bool | Verify campaign's network affinity |

**Key Invariant:**
```
All campaign lookups verify:
  campaign.network_id == current_deployment.network_id AND
  campaign.deployment_id == current_deployment.deployment_version
```

---

### Objective 4: Asset Metadata & Risk Management
**File:** `/FOUR_OBJECTIVES_SPECIFICATION.md#objective-4`

**Problem:** No way to track which tokens are verified, flagged, or deprecated. No issuer risk metadata. Campaigns can use compromised or unvetted assets without warnings.

**Solution:**
- Add `AssetReviewStatus` enum: `Unreviewed`, `Approved`, `Flagged`, `Deprecated`.
- Add `AssetMetadata` struct capturing asset code, issuer, verification URL, review status, and network binding.
- Add `AssetRiskFlag` struct for logging known issues (e.g., issuer bankruptcy, smart contract bug).
- Snapshot token review status in campaign at creation time.
- Reject `Deprecated` tokens; warn on `Flagged` tokens.

**New Functions:**
| Function | Returns | Purpose |
|----------|---------|---------|
| `register_asset_metadata(metadata)` | void | Register asset and issuer info |
| `update_asset_review_status(token, status, reason)` | void | Update asset approval/risk status |
| `raise_asset_risk_flag(token, reason, severity, remediation)` | void | Log known issue with asset |
| `clear_asset_risk_flag(token, flag_idx)` | void | Mark risk flag as resolved |
| `get_asset_metadata(token)` | Option\<AssetMetadata\> | Query asset info |
| `get_asset_risk_flags(token, start, limit)` | Vec\<AssetRiskFlag\> | Query risk history |
| `get_campaign_token_status(id)` | CampaignTokenStatus | Query combined campaign + token risk |

**Key Invariant:**
```
Campaign.token_review_status = snapshot at creation time
AssetMetadata.review_status = current status
If current_status == Deprecated: reject new campaigns
If current_status == Flagged: warn but allow with flag
```

---

## Data Model Additions at a Glance

### New Enums
```rust
CampaignLifecycle {
  Active,
  ReadOnlyMigration,
  RetiredReadOnly,
  SupersededBy(u64),
}

AssetReviewStatus {
  Unreviewed,
  Approved,
  Flagged,
  Deprecated,
}
```

### New Structs
```rust
OperationPauseFlags {
  pause_deposits: bool,
  pause_payouts: bool,
  pause_claims: bool,
  pause_admin: bool,
}

DeploymentIdentity {
  contract_address: Address,
  network_id: String,
  initialized_at: u64,
  deployment_version: u64,
}

AssetMetadata {
  token_address: Address,
  asset_code: String,
  issuer_account: String,
  issuer_name: String,
  issuer_verification_url: String,
  review_status: AssetReviewStatus,
  last_review_timestamp: u64,
  last_reviewed_by: Address,
  canonical_network_id: String,
}

AssetRiskFlag {
  token_address: Address,
  flag_reason: String,
  flagged_at: u64,
  flagged_by: Address,
  estimated_severity: u32,  // 1-10
  remediation_info: String,
}

PauseAuditEntry {
  campaign_id: u64,
  timestamp: u64,
  changed_by: Address,
  old_flags: OperationPauseFlags,
  new_flags: OperationPauseFlags,
  reason: String,
}

CampaignTokenStatus {
  campaign_id: u64,
  token_address: Address,
  asset_metadata: Option<AssetMetadata>,
  review_status_at_creation: AssetReviewStatus,
  current_review_status: AssetReviewStatus,
  active_risk_flags: Vec<AssetRiskFlag>,
  timestamp_queried: u64,
}
```

### Campaign Struct Extensions
```rust
Campaign {
  // ... existing fields ...
  
  // NEW: Objective 3 (network binding)
  deployment_id: u64,          // deployment_version at creation
  network_id: String,          // network at creation
  
  // NEW: Objective 4 (token risk snapshot)
  token_review_status: AssetReviewStatus,  // snapshot at creation
}
```

### New DataKey Variants (11 total)
```rust
// Objective 1: Retirement
CampaignLifecycle(u64)
CampaignRetiredAt(u64)
MigrationRetirementDeadline(u64)

// Objective 2: Granular Pausing
OperationPauseFlags(u64)
PauseAuditLog(u64, u32)

// Objective 3: Deployment Binding
DeploymentIdentity

// Objective 4: Asset Metadata
AssetMetadata(Address)
AssetRiskFlags(Address, u32)
AssetRiskFlagCount(Address)
AssetReviewHistory(Address, u32)
```

---

## Error Codes (9 new codes: 45–53)

| Code | Name | Objective | Triggered By |
|------|------|-----------|---|
| 45 | `CampaignRetired` | 1 | State change on `RetiredReadOnly` or `SupersededBy` campaign |
| 46 | `DepositsPaused` | 2 | `contribute()` when `pause_deposits == true` |
| 47 | `PayoutsPaused` | 2 | `claim_funds()` when `pause_payouts == true` |
| 48 | `ClaimsPaused` | 2 | `refund_claim()` when `pause_claims == true` |
| 49 | `AdminOperationsPaused` | 2 | Verify/dispute when `pause_admin == true` |
| 50 | `PauseConfigurationInvalid` | 2 | Attempt to set `pause_payouts` without `pause_admin` |
| 51 | `NetworkMismatch` | 3 | Campaign's network differs from deployment network |
| 52 | `DeploymentMismatch` | 3 | Campaign's deployment version differs |
| 53 | `TokenDeprecated` | 4 | Attempt to use `Deprecated` token for new campaign |

---

## Event Summary (10 new events)

| Event | Objective | Emitted By |
|-------|-----------|-----------|
| `CampaignRetirementInitiatedEvent` | 1 | `initiate_retirement()` |
| `CampaignTransitionedToRetiredEvent` | 1 | `finalize_retirement()` |
| `CampaignSupersedededEvent` | 1 | `mark_superseded()` |
| `OperationPauseChangedEvent` | 2 | `set_operation_pause_flags()` |
| `DeploymentInitializedEvent` | 3 | `initialize()` |
| `NetworkMismatchDetectedEvent` | 3 | Lookup guard (on mismatch) |
| `AssetMetadataRegisteredEvent` | 4 | `register_asset_metadata()` |
| `AssetReviewStatusChangedEvent` | 4 | `update_asset_review_status()` |
| `AssetRiskFlagRaisedEvent` | 4 | `raise_asset_risk_flag()` |
| `AssetRiskFlagClearedEvent` | 4 | `clear_asset_risk_flag()` |

---

## State Guards & Invariants

### Objective 1: Lifecycle State Transitions

```
Active
  ↓ (initiate_retirement with deadline)
ReadOnlyMigration
  ↓ (finalize_retirement after deadline)
RetiredReadOnly

Active
  ↓ (mark_superseded)
SupersededBy(new_id)
```

**Operations Allowed:**

| Operation | Active | ReadOnly­Migration | Retired­ReadOnly | Superseded |
|-----------|--------|-------------------|-----------------|-----------|
| `contribute()` | ✓ | ✗ | ✗ | ✗ |
| `claim_funds()` | ✓ | ✓ | ✗ | ✗ |
| `verify_campaign()` | ✓ | ✓ | ✗ | ✗ |
| `refund_claim()` | ✓ | ✓ | ✗ | ✗ |
| `get_campaign()` | ✓ | ✓ | ✓ | redirect |
| `get_contributions()` | ✓ | ✓ | ✓ | redirect |

### Objective 2: Pause Configuration Constraints

```
Valid:
  { pause_deposits=true,  pause_payouts=false, pause_claims=false, pause_admin=false }
  { pause_deposits=false, pause_payouts=true,  pause_claims=true,  pause_admin=true  }
  { pause_deposits=true,  pause_payouts=true,  pause_claims=true,  pause_admin=true  }

Invalid (violates invariant):
  { pause_deposits=false, pause_payouts=true,  pause_claims=false, pause_admin=false }
  ❌ pause_payouts=true requires pause_admin=true
```

### Objective 3: Network & Deployment Guards

Every state-changing operation must verify:
```rust
fn assert_same_network_and_deployment(
  campaign.network_id == deployment.network_id &&
  campaign.deployment_id == deployment.deployment_version
)
```

### Objective 4: Asset Review State Transitions

```
Unreviewed
  ↓ (update_asset_review_status)
Approved  ←→  Flagged
  ↓              ↓
Deprecated    Deprecated
```

**Operations Blocked/Warned:**

| Token Status | New Campaign? | Contribute? | Claim? |
|--------------|---------------|-----------|--------|
| Unreviewed | Allow + warn | Allow + warn | Allow |
| Approved | Allow | Allow | Allow |
| Flagged | Allow + warn | Allow + warn | Allow + warn |
| Deprecated | ✗ Reject | ✗ Reject | Allow |

---

## Integration Checklist for Off-Chain Systems

### SDK (TypeScript/JavaScript)

- [ ] Cache `DeploymentIdentity` on initialization
- [ ] Include `network_id` and `deployment_version` in campaign queries
- [ ] Subscribe to `CampaignRetirementInitiatedEvent` for countdown timers
- [ ] Subscribe to `CampaignSupersedededEvent` to redirect queries
- [ ] Query `get_campaign_token_status()` to display risk flags
- [ ] Subscribe to `AssetReviewStatusChangedEvent` to update risk UI in real-time
- [ ] Implement pause flag checks before enabling contribute/claim/verify UIs
- [ ] Store pause audit log locally for debugging and transparency

### Mobile (React Native)

- [ ] Display migration deadline countdown when campaign is in `ReadOnlyMigration`
- [ ] Show "Asset Flagged" banner on campaigns with flagged tokens
- [ ] Disable deposit input when `pause_deposits == true`
- [ ] Disable claim button when `pause_claims == true`
- [ ] Display full pause audit log in campaign details screen (optional: premium feature)
- [ ] Handle network mismatch errors gracefully (show error, suggest network switch)

### Web (React/Next.js)

- [ ] Add campaign retirement status indicator (Active / Migrating / Retired / Superseded)
- [ ] Add risk badge to campaign cards (Flagged / Deprecated)
- [ ] Show asset metadata (issuer name, verification URL) on token info modal
- [ ] Implement pause status display (show which operations are paused and why)
- [ ] Redirect users from old campaign ID to new campaign ID on supersedence
- [ ] Add "Network" selector to campaign search (prevent cross-network queries)

### Analytics / Indexing

- [ ] Index all `CampaignRetirementInitiatedEvent` events to track retirement pipeline
- [ ] Index `OperationPauseChangedEvent` for pause analytics
- [ ] Index `AssetReviewStatusChangedEvent` to track asset risk timeline
- [ ] Build dashboard showing campaigns by lifecycle state
- [ ] Build asset risk report (flagged tokens, count of affected campaigns)

---

## Backward Compatibility

- ✓ No breaking changes to existing storage keys
- ✓ No removal of existing data types
- ✓ New fields in `Campaign` struct default to safe values for old campaigns
- ✓ New `DataKey` variants are additions only
- ✓ `initialize()` signature extended (new params) but existing params unchanged
- ⚠️ Off-chain systems must be updated to handle new events and status fields

---

## Deployment Sequence

### Phase 1: Code & Testing
1. Implement all four objectives in contract code
2. Write unit tests per objective
3. Write integration tests across objectives
4. Run full test suite and audit

### Phase 2: Testnet Deployment
1. Deploy to testnet with `network_id="testnet-soroban"`, `deployment_version=1`
2. Register test assets with `AssetMetadata`
3. Create test campaigns and exercise all pause/retirement/token-status flows
4. Validate off-chain systems (SDK, mobile, web) recognize new events and status

### Phase 3: Mainnet Deployment
1. Deploy to mainnet with `network_id="mainnet"`, `deployment_version=1`
2. Initialize `DeploymentIdentity` with correct mainnet network ID
3. Register production assets with `AssetMetadata`
4. All existing campaigns are "migrated" by setting `deployment_id=1`, `network_id="mainnet"` retroactively

### Phase 4: Off-Chain Rollout
1. Release SDK version with new queries (`get_campaign_token_status()`, etc.)
2. Roll out mobile and web with pause flags UI
3. Update analytics dashboards to show retirement/pause/risk metrics
4. Monitor event streams for errors

---

## Cross-Reference Matrix

| Feature | Objective 1 | Objective 2 | Objective 3 | Objective 4 |
|---------|-----------|-----------|-----------|-----------|
| **Retirement** | ✓ Primary | ✓ Sec (pause blocks ops) | ✓ (network check) | ✓ (warn on flagged) |
| **Granular Pause** | ✓ (block on retired) | ✓ Primary | ✓ (network check) | — |
| **Network Binding** | ✓ (guard retirement) | ✓ (guard pause) | ✓ Primary | ✓ (asset canonical network) |
| **Asset Risk** | — | — | — | ✓ Primary |

---

## Next Steps

1. **Read full spec:** `/FOUR_OBJECTIVES_SPECIFICATION.md`
2. **Review data model:** Line-by-line additions to enums, structs, DataKey
3. **Identify gaps:** Compare against current contract implementation
4. **Prioritize implementation:** Recommend Obj 3 first (deployment binding is foundation for all), then Obj 1, 2, 4
5. **Plan off-chain updates:** Notify SDK, mobile, web teams of new status fields and events
6. **Schedule audit:** Plan security review of pause invariant and network guard logic

