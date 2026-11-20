# Four Objectives Specification: Complete Index

This is the **index and entry point** for the comprehensive technical specification addressing four critical improvements to the Stellar campaign-funding contract.

---

## Document Map

### 1. This Index (START HERE)
**File:** `FOUR_OBJECTIVES_INDEX.md`
- Navigation to all specification documents
- Overview of what each objective addresses
- Quick links and reading order recommendations

### 2. Executive Summary & Quick Reference
**File:** `FOUR_OBJECTIVES_SUMMARY.md` (16 KB)
- One-page overview of each objective
- Quick reference tables for data model additions
- Error codes, events, and new entry points
- Integration checklist for off-chain systems
- State transition diagrams

**Read this if:** You want a high-level overview before diving into details, or need to brief stakeholders.

### 3. Complete Technical Specification
**File:** `FOUR_OBJECTIVES_SPECIFICATION.md` (45 KB)
- Detailed architecture for all four objectives
- Section per objective with:
  - Current state analysis
  - Required fixes
  - Data model changes (exact struct/enum definitions)
  - Contract function signatures
  - Authorization matrix
  - State guards and invariants
- Cross-objective interactions
- Testing strategy
- Migration and deployment considerations

**Read this if:** You are implementing the changes, designing the integration, or need to understand the full picture.

### 4. Gaps Analysis
**File:** `FOUR_OBJECTIVES_GAPS_ANALYSIS.md` (27 KB)
- Line-by-line mapping of current code to gaps
- What's missing and why it matters
- How each gap is fixed
- Before/after code examples
- Summary matrix of gaps vs. fixes

**Read this if:** You want to understand what currently doesn't work and why the changes are necessary.

---

## The Four Objectives

### Objective 1: Retire Deployments While Preserving Claims, Historical Reads, and Transparent Migration Choices

**File:** `FOUR_OBJECTIVES_SPECIFICATION.md#objective-1`

**Summary:**
- Add `CampaignLifecycle` enum to separate deployment retirement from campaign execution state
- Campaigns can transition: `Active` → `ReadOnlyMigration` → `RetiredReadOnly`
- Allow claims and verification during migration window; block new contributions
- Provide `mark_superseded()` to link old campaigns to new ones after redeployment

**Key Invariant:**
```
Active: all operations allowed
ReadOnlyMigration: claims/verify allowed, contributions blocked
RetiredReadOnly: only historical reads allowed, no state changes
SupersededBy(new_id): redirect queries to new campaign
```

**Data Model Additions:**
- Enum: `CampaignLifecycle`
- DataKey: `CampaignLifecycle(u64)`, `CampaignRetiredAt(u64)`, `MigrationRetirementDeadline(u64)`
- Events: `CampaignRetirementInitiatedEvent`, `CampaignTransitionedToRetiredEvent`, `CampaignSupersedededEvent`

**Impact:** Enables graceful deployment transitions without breaking user access or data integrity.

---

### Objective 2: Separate Pausing Deposits, Payouts, Claims, and Administration Without Granting Fund-Redirection Authority

**File:** `FOUR_OBJECTIVES_SPECIFICATION.md#objective-2`

**Summary:**
- Replace monolithic `Paused` state with `OperationPauseFlags` bitmask
- Four independent flags: `pause_deposits`, `pause_payouts`, `pause_claims`, `pause_admin`
- Enforce invariant: if `pause_payouts` then `pause_admin` (prevents fund redirection)
- Maintain audit log of all pause state changes

**Key Invariant:**
```
pause_payouts=true ⟹ pause_admin=true  // Prevents fund redirection attacks
```

**Data Model Additions:**
- Struct: `OperationPauseFlags`, `PauseAuditEntry`
- DataKey: `OperationPauseFlags(u64)`, `PauseAuditLog(u64, u32)`
- Error codes: `DepositsPaused`, `PayoutsPaused`, `ClaimsPaused`, `AdminOperationsPaused`, `PauseConfigurationInvalid`
- Events: `OperationPauseChangedEvent`

**Impact:** Provides fine-grained control over campaign operations while preventing abuse of pause authority.

---

### Objective 3: Include Network and Deployment Identity in Lookups So Redeployments Cannot Alias Historical Campaigns

**File:** `FOUR_OBJECTIVES_SPECIFICATION.md#objective-3`

**Summary:**
- Add `DeploymentIdentity` struct capturing network, contract address, version, and timestamp
- Store `network_id` and `deployment_id` in each campaign at creation
- Guard all lookups to verify network and deployment affinity
- Extend `initialize()` to accept `network_id` and `deployment_version` parameters

**Key Invariant:**
```
For all campaign lookups:
  campaign.network_id == deployment.network_id AND
  campaign.deployment_id == deployment.deployment_version
```

**Data Model Additions:**
- Struct: `DeploymentIdentity`
- Fields in Campaign: `deployment_id: u64`, `network_id: String`
- DataKey: `DeploymentIdentity`
- Error codes: `NetworkMismatch`, `DeploymentMismatch`
- Events: `DeploymentInitializedEvent`, `NetworkMismatchDetectedEvent`

**Impact:** Prevents cross-network and cross-deployment aliasing; binds campaigns to canonical deployments.

---

### Objective 4: Bind Assets to Canonical Network Identifiers and Expose Review, Retirement, and Issuer-Risk Status

**File:** `FOUR_OBJECTIVES_SPECIFICATION.md#objective-4`

**Summary:**
- Add `AssetMetadata` registry with issuer info, asset code, and verification URL
- Add `AssetReviewStatus` enum: `Unreviewed`, `Approved`, `Flagged`, `Deprecated`
- Add `AssetRiskFlag` to track known issues and severity
- Snapshot asset review status in campaign at creation time
- Reject deprecated tokens; warn on flagged tokens

**Key Invariants:**
```
Campaign can use Deprecated token: REJECT
Campaign created with Flagged token: WARN
Current asset status != Creation-time status: ALERT
```

**Data Model Additions:**
- Enum: `AssetReviewStatus`
- Structs: `AssetMetadata`, `AssetRiskFlag`, `CampaignTokenStatus`
- Fields in Campaign: `token_review_status: AssetReviewStatus`
- DataKey: `AssetMetadata(Address)`, `AssetRiskFlags(Address, u32)`, `AssetRiskFlagCount(Address)`, `AssetReviewHistory(Address, u32)`
- Error codes: `TokenDeprecated`, `AssetAlreadyRegistered`, `AssetNotRegistered`, `InvalidRiskSeverity`
- Events: `AssetMetadataRegisteredEvent`, `AssetReviewStatusChangedEvent`, `AssetRiskFlagRaisedEvent`, `AssetRiskFlagClearedEvent`

**Impact:** Enables operators to manage asset risk, track issuer issues, and warn users of compromised tokens.

---

## Reading Recommendations

### For Project Managers / Stakeholders
1. Read this index
2. Skim `FOUR_OBJECTIVES_SUMMARY.md` for high-level overview
3. Review "Four Objectives" section above for business impact

### For Smart Contract Engineers
1. Read this index
2. Read `FOUR_OBJECTIVES_GAPS_ANALYSIS.md` to understand current state
3. Read `FOUR_OBJECTIVES_SPECIFICATION.md` in full for implementation guidance

### For Off-Chain Developers (SDK, Mobile, Web)
1. Read this index
2. Read `FOUR_OBJECTIVES_SUMMARY.md` section "Integration Checklist for Off-Chain Systems"
3. Reference `FOUR_OBJECTIVES_SPECIFICATION.md#contract-interaction-impact` for each objective

### For Security / Auditors
1. Read `FOUR_OBJECTIVES_GAPS_ANALYSIS.md` to understand current gaps
2. Read `FOUR_OBJECTIVES_SPECIFICATION.md#state-mutation-guards` and invariants for each objective
3. Focus on Objective 2's fund-redirection prevention and Objective 3's network guards

### For Operations / Deployment Teams
1. Read this index
2. Read `FOUR_OBJECTIVES_SUMMARY.md#deployment-sequence`
3. Reference `FOUR_OBJECTIVES_SPECIFICATION.md#migration--deployment-considerations`

---

## Key Statistics

| Metric | Value |
|--------|-------|
| **Total specification size** | 88 KB (3 documents) |
| **New enums** | 2 (CampaignLifecycle, AssetReviewStatus) |
| **New structs** | 8 (OperationPauseFlags, DeploymentIdentity, AssetMetadata, AssetRiskFlag, PauseAuditEntry, CampaignTokenStatus, and 2 more) |
| **New DataKey variants** | 11 |
| **Campaign struct extensions** | 4 fields |
| **New entry points** | 14 contract functions |
| **New error codes** | 9 (codes 45–53) |
| **New events** | 10 |
| **Cross-objective dependencies** | 12 points of integration |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│   Campaign Funding Contract (campaign-funding)  │
├─────────────────────────────────────────────────┤
│                                                 │
│  Objective 3: FOUNDATION                        │
│  ├─ DeploymentIdentity (network + version)     │
│  └─ Network/deployment guards on ALL ops       │
│                                                 │
│  Objective 1: RETIREMENT LAYER                 │
│  ├─ CampaignLifecycle (Active → ... → Retired) │
│  ├─ Migration deadline enforcement             │
│  └─ Supersedence tracking (old → new)          │
│                                                 │
│  Objective 2: PAUSE CONTROL LAYER              │
│  ├─ OperationPauseFlags (4 independent flags)  │
│  ├─ Fund-redirection prevention invariant      │
│  └─ Audit log of all pause changes             │
│                                                 │
│  Objective 4: ASSET RISK LAYER                 │
│  ├─ AssetMetadata registry (issuer info)       │
│  ├─ AssetReviewStatus (Unreviewed...Deprecated)│
│  ├─ AssetRiskFlag tracking (issues + severity) │
│  └─ Token status snapshots per campaign        │
│                                                 │
└─────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────┐
│   Related Contracts & Off-Chain Systems         │
├─────────────────────────────────────────────────┤
│ • Payment Stream (reward streams)               │
│ • Carbon Credits (token minting)                │
│ • Tax Certificates (deduction docs)             │
│ • SDK (TypeScript client)                       │
│ • Mobile (React Native app)                     │
│ • Web (React/Next.js frontend)                  │
│ • Analytics (indexing & dashboards)             │
└─────────────────────────────────────────────────┘
```

---

## State Machine Diagram (Objective 1)

```
                    ┌─────────────┐
                    │   Active    │
                    └─────────────┘
                          │
                          │ initiate_retirement()
                          ↓
                ┌──────────────────────┐
                │ ReadOnlyMigration    │
                │ (deadline = now + Nd)│
                └──────────────────────┘
                          │
                          │ finalize_retirement()
                          │ (after deadline)
                          ↓
                ┌──────────────────────┐
                │  RetiredReadOnly     │
                │ (archive mode)       │
                └──────────────────────┘

Alternative path (mark_superseded):
┌─────────────┐      ┌──────────────────────┐
│   Active    │ ───→ │ SupersededBy(new_id) │
└─────────────┘      │ (redirect to new)    │
                     └──────────────────────┘

Operations Allowed (√ = allowed):
         │ Active │ ReadOnly │ Retired │ Superseded │
─────────┼────────┼──────────┼─────────┼────────────┤
Contrib  │   √    │    ✗     │   ✗     │    ✗       │
Claim    │   √    │    √     │   ✗     │    ✗       │
Verify   │   √    │    √     │   ✗     │    ✗       │
Read     │   √    │    √     │   √     │  redirect  │
```

---

## Error Code Reference

### Objective 1: Retirement (Code 45)
| Code | Name | Scenario |
|------|------|----------|
| 45 | `CampaignRetired` | State change attempted on `RetiredReadOnly` or `SupersededBy` campaign |

### Objective 2: Granular Pause (Codes 46–50)
| Code | Name | Scenario |
|------|------|----------|
| 46 | `DepositsPaused` | `contribute()` when `pause_deposits=true` |
| 47 | `PayoutsPaused` | `claim_funds()` when `pause_payouts=true` |
| 48 | `ClaimsPaused` | `refund_claim()` when `pause_claims=true` |
| 49 | `AdminOperationsPaused` | `verify_campaign()` when `pause_admin=true` |
| 50 | `PauseConfigurationInvalid` | Attempt to set invalid pause config (e.g., `pause_payouts` without `pause_admin`) |

### Objective 3: Network Binding (Codes 51–52)
| Code | Name | Scenario |
|------|------|----------|
| 51 | `NetworkMismatch` | Campaign's network differs from deployment's network |
| 52 | `DeploymentMismatch` | Campaign's deployment version differs from current version |

### Objective 4: Asset Risk (Codes 53–56)
| Code | Name | Scenario |
|------|------|----------|
| 53 | `TokenDeprecated` | Attempt to create campaign or contribute with `Deprecated` token |
| 54 | `AssetAlreadyRegistered` | Attempt to re-register already-registered asset |
| 55 | `AssetNotRegistered` | Optional: attempt to query unregistered asset (usually allow) |
| 56 | `InvalidRiskSeverity` | Risk flag severity not in [1, 10] |

---

## Cross-Objective Dependency Matrix

| Objective | Depends On | Interaction |
|-----------|-----------|------------|
| 1: Retirement | 3: Network | All retirement guards verify network affinity |
| 2: Pause | 3: Network | All pause checks verify network affinity |
| 2: Pause | 1: Retirement | Retired campaigns always have `pause_admin=true` |
| 4: Asset Risk | 3: Network | Asset metadata keyed by token address, verified per network |
| 4: Asset Risk | 1: Retirement | Token status snapshots preserved across retirement |

---

## File Locations & Sizes

| Document | File | Size | Lines | Purpose |
|----------|------|------|-------|---------|
| This Index | `FOUR_OBJECTIVES_INDEX.md` | — | — | Navigation & overview |
| Summary | `FOUR_OBJECTIVES_SUMMARY.md` | 16 KB | 445 | High-level reference |
| Full Spec | `FOUR_OBJECTIVES_SPECIFICATION.md` | 45 KB | 1050 | Complete architecture |
| Gaps Analysis | `FOUR_OBJECTIVES_GAPS_ANALYSIS.md` | 27 KB | 825 | Current → proposed mapping |

**Total:** 88 KB, ~2300 lines

---

## Contact & Questions

For questions about this specification:

1. **Architecture & design:** Review the appropriate section in `FOUR_OBJECTIVES_SPECIFICATION.md`
2. **Current state & gaps:** Check `FOUR_OBJECTIVES_GAPS_ANALYSIS.md`
3. **Quick facts & tables:** See `FOUR_OBJECTIVES_SUMMARY.md`
4. **Implementation details:** See the full specification

---

## Version History

| Date | Status | Author |
|------|--------|--------|
| 2024-11-20 | Draft | AI Analysis |
| TBD | Final | Review by team |

---

## Next Steps

1. **Review Phase:** Stakeholders and technical leads review all three documents
2. **Design Approval:** Sign off on data model, invariants, and contract signatures
3. **Implementation:** Engineers implement changes per specification
4. **Testing:** Unit and integration tests per section 5 of full spec
5. **Audit:** Security review of pause invariants and network guards
6. **Deployment:** Phased rollout (testnet, mainnet, off-chain systems)

---

**START READING:** Choose your path above based on your role and needs. All documents are in `/workspaces/stellar_client_os/` directory.

