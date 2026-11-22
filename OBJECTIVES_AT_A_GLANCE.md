# Four Objectives - At a Glance

## Quick Reference Card

### Objective 1: Campaign Retirement & Migration
```
Lifecycle: Active → ReadOnlyMigration → RetiredReadOnly (one-way)
├── Read operations: ✓ Allowed in all states
├── Write operations: ✗ Blocked in ReadOnlyMigration/RetiredReadOnly
├── Historical access: ✓ Preserved forever
└── User migration: ⚠ Warning window during ReadOnlyMigration

Error Codes: 48, 49, 50
Types Added: CampaignLifecycle enum, 2 DataKey entries, 2 events
Fields Added to Campaign: lifecycle_state: CampaignLifecycle
```

### Objective 2: Granular Pause Controls
```
Independent Operation Flags:
├── pause_deposits ───→ Blocks new contributions
├── pause_payouts ───→ Blocks creator fund claims (implies pause_admin)
├── pause_claims ────→ Blocks refunds & milestone claims
└── pause_admin ─────→ Blocked if pause_payouts=true (fund-redirection prevention)

Error Codes: 51, 52, 53, 54
Types Added: OperationPauseFlags struct, 1 DataKey entry, 2 events
Fields Added to Campaign: pause_flags: OperationPauseFlags
```

### Objective 3: Network & Deployment Binding ⭐ FOUNDATION
```
Campaign Identity = (campaign_id, deployment_id, network_id)
├── Prevents testnet ↔ mainnet aliasing
├── Prevents old_deploy ↔ new_deploy aliasing
├── Assets registered per network
└── Cross-network usage rejected

Error Codes: 44, 45, 46, 47
Types Added: DeploymentIdentity struct, AssetNetworkBinding struct, 2 DataKey entries, 3 events
Fields Added to Campaign: deployment_id, network_id (both BytesN<32>)
```

### Objective 4: Asset Risk Management
```
Review Status Flow: Pending → Approved (or flagged/retired)
├── Pending: Not yet reviewed
├── Approved: Verified safe
├── Flagged: Known issues but usable
└── Retired: No new campaigns

Risk Flags:
├── reputation_risk: Issuer history issues
├── liquidity_risk: Low volume/wide spreads
└── concentration_risk: Holdings concentration

Error Codes: 55, 56, 57, 58
Types Added: AssetMetadata, AssetReviewStatus enum, AssetRiskFlags, 4 DataKey entries, 4 events
Fields Added to Campaign: (none - separate registry)
```

---

## Implementation Status

| Component | Status | Lines | Items |
|-----------|--------|-------|-------|
| Objective 1 | ✓ DONE | ~65 | 1 enum, 2 keys, 2 events, 3 errors, 1 field |
| Objective 2 | ✓ DONE | ~75 | 1 struct, 1 key, 2 events, 4 errors, 1 field |
| Objective 3 | ✓ DONE | ~80 | 2 structs, 2 keys, 3 events, 4 errors, 2 fields |
| Objective 4 | ✓ DONE | ~134 | 3 types, 4 keys, 4 events, 4 errors, 0 fields |
| **TOTAL** | ✓ DONE | **354** | **12 types, 9 keys, 11 events, 15 errors, 5 fields** |

---

## Quick Decision Tree: Which Error to Return?

```
Is campaign missing from storage?
├─ YES → 44: DeploymentIdentityMissing (Obj 3)
└─ NO → continue

Is deployment_id or network_id wrong?
├─ YES → 45: NetworkBindingMissing (Obj 3)
└─ NO → continue

Does campaign network_id match asset network_id?
├─ NO → 46: NetworkBindingMismatch (Obj 3)
└─ YES → continue

Is campaign in ReadOnlyMigration state?
├─ YES → 49: CampaignInMigration (Obj 1)
└─ NO → continue

Is campaign in RetiredReadOnly state?
├─ YES → 50: CampaignRetired (Obj 1)
└─ NO → continue

Is pause_deposits=true and operation is deposit?
├─ YES → 51: DepositsCurrentlyPaused (Obj 2)
└─ NO → continue

Is pause_payouts=true and operation is payout?
├─ YES → 52: PayoutsCurrentlyPaused (Obj 2)
└─ NO → continue

Is pause_claims=true and operation is claim?
├─ YES → 53: ClaimsCurrentlyPaused (Obj 2)
└─ NO → continue

Is pause_admin=true and operation is admin?
├─ YES → 54: AdminOperationsPaused (Obj 2)
└─ NO → continue

Is asset not in AssetMetadata registry?
├─ YES → 55: AssetMetadataNotFound (Obj 4)
└─ NO → continue

Is asset review status = Approved?
├─ NO → 56: AssetNotApproved (Obj 4)
└─ YES → continue

Is asset review status = Retired?
├─ YES → 57: AssetRetired (Obj 4)
└─ NO → continue

Is issuer risk reputation_risk=true?
├─ YES → 58: IssuerRiskTooHigh (Obj 4)
└─ NO → SUCCESS
```

---

## File Locations in lib.rs

| Component | Location (approx line) |
|-----------|----------------------|
| DataKey enum entries | 198-224 |
| CampaignLifecycle enum | 286-304 |
| OperationPauseFlags struct | 307-323 |
| AssetMetadata struct | 326-338 |
| AssetReviewStatus enum | 340-353 |
| AssetRiskFlags struct | 356-367 |
| DeploymentIdentity struct | 254-265 |
| AssetNetworkBinding struct | 269-282 |
| Campaign struct enhancements | 437-446 |
| Events (all) | 743-874 |
| Error codes | 1000-1200 (search `error_code`) |

---

## Testing Checklist Template

### Objective 1 Tests
- [ ] Campaign starts in Active state
- [ ] Can transition Active → ReadOnlyMigration
- [ ] Can transition ReadOnlyMigration → RetiredReadOnly
- [ ] Cannot transition backwards
- [ ] Writes blocked in ReadOnlyMigration
- [ ] Writes blocked in RetiredReadOnly
- [ ] Reads work in all states
- [ ] Events emitted on transitions

### Objective 2 Tests
- [ ] All pause flags default to false
- [ ] pause_deposits blocks deposit()
- [ ] pause_payouts blocks payout()
- [ ] pause_claims blocks claim()
- [ ] pause_admin blocks admin operations
- [ ] pause_payouts=true enforces pause_admin=true
- [ ] Resume works for each flag independently
- [ ] Events emitted on pause/resume

### Objective 3 Tests
- [ ] deployment_id set on campaign creation
- [ ] network_id set on campaign creation
- [ ] Asset registration requires network_id
- [ ] Cross-network asset use rejected
- [ ] Same campaign_id different network rejected
- [ ] deployment_id immutable
- [ ] network_id immutable
- [ ] Events emitted on binding

### Objective 4 Tests
- [ ] Asset registers in Pending status
- [ ] Status changes to Approved
- [ ] Status changes to Flagged
- [ ] Status changes to Retired
- [ ] Retired assets rejected for new campaigns
- [ ] Risk flags can be set independently
- [ ] Issuer risk tracked separately
- [ ] Events emitted on all changes

---

## Integration Checklist

Before deploying:

- [ ] All four objectives compile without errors
- [ ] All error codes are unique (44-58)
- [ ] Campaign struct can serialize/deserialize with new fields
- [ ] All new types have `#[contracttype]` or `#[contractevent]` macros
- [ ] No type name conflicts with existing code
- [ ] Documentation strings present on all new types
- [ ] Function signatures updated to use new types where applicable
- [ ] Tests pass for each objective
- [ ] Cross-objective integration tests pass
- [ ] Code reviewed for security implications
- [ ] Network team informed of network_id binding requirements

---

## Support & Questions

See detailed documentation:
- **Architecture:** FOUR_OBJECTIVES_SPECIFICATION.md
- **Gaps & Changes:** FOUR_OBJECTIVES_GAPS_ANALYSIS.md
- **Visual Reference:** FOUR_OBJECTIVES_VISUAL_REFERENCE.txt
- **Implementation Guide:** IMPLEMENTATION_COMPLETE.md
