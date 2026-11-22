# Quick Reference: Four Objectives Implementation

## File Location
`/workspaces/stellar_client_os/contracts/campaign-funding/src/lib.rs`

---

## PHASE 1: Network Binding

### Key Types
```rust
DeploymentIdentity {
    network_id: BytesN<32>,
    contract_address: Address,
    deploy_timestamp: u64,
}

AssetNetworkBinding {
    asset: Address,
    network_id: BytesN<32>,
    verified: bool,
}

CampaignStatus::Paused           // (existing - still available)
```

### Storage Keys
- `DataKey::DeploymentIdentity` - Initialize once at contract startup
- `DataKey::NetworkRegistry(asset)` - One per verified asset

### Critical Errors
- `Error::NetworkIdentityNotInitialized` (44)
- `Error::NetworkBindingMismatch` (46)

---

## PHASE 2: Campaign Retirement

### Key Types
```rust
CampaignLifecycle {
    Active = 0,              // Normal operation
    ReadOnlyMigration = 1,   // No writes allowed
    RetiredReadOnly = 2,     // Fully archived
}
```

### Storage Keys
- `DataKey::CampaignLifecycle(campaign_id)` - One per campaign
- `DataKey::RetirementTimestamp(campaign_id)` - One per retired campaign

### Critical Errors
- `Error::CampaignInReadOnlyMode` (48)
- `Error::CampaignRetired` (49)

### Implementation Pattern
```rust
// Before any write operation:
if campaign.lifecycle_state != CampaignLifecycle::Active {
    return Err(Error::CampaignInReadOnlyMode);
}
```

---

## PHASE 3: Granular Pause Controls

### Key Type
```rust
OperationPauseFlags {
    pause_deposits: bool,    // Block contributions
    pause_payouts: bool,     // Block fund releases
    pause_claims: bool,      // Block refunds
    pause_admin: bool,       // Block admin ops
}
```

### Storage Key
- `DataKey::OperationPauseFlags(campaign_id)` - One per campaign

### Critical Errors
- `Error::OperationDepositsPaused` (51)
- `Error::OperationPayoutsPaused` (52)
- `Error::OperationClaimsPaused` (53)
- `Error::OperationAdminPaused` (54)

### Implementation Pattern
```rust
// Before accept deposit:
if campaign.pause_flags.pause_deposits {
    return Err(Error::OperationDepositsPaused);
}

// Before payout:
if campaign.pause_flags.pause_payouts {
    return Err(Error::OperationPayoutsPaused);
}

// Before claim:
if campaign.pause_flags.pause_claims {
    return Err(Error::OperationClaimsPaused);
}

// Before admin action:
if campaign.pause_flags.pause_admin {
    return Err(Error::OperationAdminPaused);
}
```

---

## PHASE 4: Asset Metadata & Risk

### Key Types
```rust
AssetMetadata {
    token: Address,
    issuer: Address,
    verified_at: u64,
    last_review: u64,
}

AssetReviewStatus {
    Pending = 0,
    Approved = 1,
    Flagged = 2,
    Retired = 3,
}

AssetRiskFlags {
    reputation_risk: bool,
    liquidity_risk: bool,
    concentration_risk: bool,
}
```

### Storage Keys
- `DataKey::AssetMetadata(token)` - Asset registry
- `DataKey::AssetReviewStatus(token)` - Review status
- `DataKey::AssetRiskFlags(token)` - Risk assessment
- `DataKey::IssuerRiskRegistry(issuer)` - Issuer profiles

### Critical Errors
- `Error::AssetMetadataNotFound` (55)
- `Error::AssetFlagged` (56)
- `Error::AssetRetired` (57)
- `Error::IssuerHighRisk` (58)

### Implementation Pattern
```rust
// Validate token before campaign creation:
let status = env.storage().persistent().get(&DataKey::AssetReviewStatus(token))?;

match status {
    AssetReviewStatus::Approved => Ok(()),
    AssetReviewStatus::Flagged => Err(Error::AssetFlagged),
    AssetReviewStatus::Retired => Err(Error::AssetRetired),
    AssetReviewStatus::Pending => Err(Error::AssetMetadataNotFound),
}

// Check issuer risk:
let issuer_risk = env.storage().persistent().get(&DataKey::IssuerRiskRegistry(issuer))?;
if issuer_risk_level == "HIGH" {
    return Err(Error::IssuerHighRisk);
}
```

---

## Campaign Struct Updates

### New Fields (Lines 428-444 approx)
```rust
pub struct Campaign {
    // ... existing 14 fields ...
    
    // PHASE 1: Network Binding
    pub deployment_id: BytesN<32>,
    pub network_id: BytesN<32>,
    
    // PHASE 2: Retirement
    pub lifecycle_state: CampaignLifecycle,
    
    // PHASE 3: Pause Control
    pub pause_flags: OperationPauseFlags,
}
```

### Initialization Template
```rust
let campaign = Campaign {
    // ... existing fields ...
    deployment_id: compute_network_hash(&env),
    network_id: compute_network_hash(&env),
    lifecycle_state: CampaignLifecycle::Active,
    pause_flags: OperationPauseFlags {
        pause_deposits: false,
        pause_payouts: false,
        pause_claims: false,
        pause_admin: false,
    },
};
```

---

## Event Reference

### Network Binding Events
- `DeploymentIdentityInitializedEvent` - Emitted at init
- `AssetNetworkBindingCreatedEvent` - New asset binding
- `AssetNetworkBindingVerifiedEvent` - Binding verified

### Retirement Events
- `CampaignMigratedToReadOnlyEvent` - Migrated to read-only
- `CampaignRetiredEvent` - Campaign retired

### Pause Events
- `CampaignOperationsPausedEvent` - Pauses activated
- `CampaignOperationsResumedEvent` - Pauses cleared

### Asset Events
- `AssetMetadataRegisteredEvent` - Asset registered
- `AssetReviewStatusChangedEvent` - Status changed
- `AssetRiskFlagsUpdatedEvent` - Risk flags updated
- `IssuerRiskRegisteredEvent` - Issuer registered

---

## Common Implementation Patterns

### 1. Validate Campaign Is Active
```rust
if campaign.lifecycle_state != CampaignLifecycle::Active {
    return Err(Error::CampaignInReadOnlyMode);
}
```

### 2. Check Operation Pause Flags
```rust
match operation_type {
    OperationType::Deposit => {
        if campaign.pause_flags.pause_deposits {
            return Err(Error::OperationDepositsPaused);
        }
    },
    OperationType::Payout => {
        if campaign.pause_flags.pause_payouts {
            return Err(Error::OperationPayoutsPaused);
        }
    },
    // ... etc
}
```

### 3. Validate Asset Before Campaign Creation
```rust
let review_status = env.storage().persistent()
    .get(&DataKey::AssetReviewStatus(&token))?;

if review_status != AssetReviewStatus::Approved {
    return Err(Error::AssetFlagged);
}
```

### 4. Verify Network Binding
```rust
let binding = env.storage().persistent()
    .get(&DataKey::NetworkRegistry(&token))?;

if binding.network_id != campaign.network_id {
    return Err(Error::NetworkBindingMismatch);
}
```

---

## Error Code Summary

| Code | Error | Phase |
|------|-------|-------|
| 44 | NetworkIdentityNotInitialized | 1 |
| 45 | NetworkIdentityAlreadyInitialized | 1 |
| 46 | NetworkBindingMismatch | 1 |
| 47 | AssetNotBound | 1 |
| 48 | CampaignInReadOnlyMode | 2 |
| 49 | CampaignRetired | 2 |
| 50 | InvalidRetirementState | 2 |
| 51 | OperationDepositsPaused | 3 |
| 52 | OperationPayoutsPaused | 3 |
| 53 | OperationClaimsPaused | 3 |
| 54 | OperationAdminPaused | 3 |
| 55 | AssetMetadataNotFound | 4 |
| 56 | AssetFlagged | 4 |
| 57 | AssetRetired | 4 |
| 58 | IssuerHighRisk | 4 |

---

## Testing Checklist

- [ ] Network binding initialized at contract creation
- [ ] Asset bindings validated correctly
- [ ] Campaign lifecycle transitions work (Active → ReadOnly → Retired)
- [ ] Read-only migration prevents all writes
- [ ] Each pause flag independently blocks operations
- [ ] Asset metadata registry works correctly
- [ ] Review status changes validated
- [ ] Risk flags prevent asset usage
- [ ] Issuer risk blocks high-risk issuers
- [ ] Cross-network attacks prevented
- [ ] All error codes properly returned

---

## Documentation Files
- Full implementation: `/workspaces/stellar_client_os/contracts/campaign-funding/src/lib.rs`
- Summary: `/workspaces/stellar_client_os/IMPLEMENTATION_SUMMARY.md`
- This guide: `/workspaces/stellar_client_os/QUICK_REFERENCE_OBJECTIVES.md`
