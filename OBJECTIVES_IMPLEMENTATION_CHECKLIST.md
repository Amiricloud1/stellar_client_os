# Implementation Checklist: Four Critical Objectives

Quick reference for implementation status and action items.

---

## Objective 1: Operation Nonces and Recovery States ⚠️ CRITICAL GAP

**Status:** Not implemented

### Current Implementation
- ✅ Stream IDs (sequential u64)
- ✅ Campaign IDs (sequential u64)  
- ✅ Dispute IDs (sequential u64)
- ✅ Stream status tracking
- ✅ Reentrancy guards (per-stream + global)

### Gaps
- ❌ No operation nonce tracking
- ❌ Cross-contract operations not correlated
- ❌ No recovery state machine
- ❌ Events don't reference operation ID
- ❌ No sequence number for operation ordering

### Required Changes

#### Contracts
- [ ] Add `OperationNonce` and `StreamOperationNonce` to `DataKey` enum
  - **File:** `payment-stream/src/lib.rs` (lines 13-35)
  
- [ ] Create `OperationStartedEvent` and `OperationCompletedEvent`
  - **File:** `payment-stream/src/lib.rs` (after line 250)
  
- [ ] Add `operation_nonce: u64` field to all financial events
  - **Files:** 
    - `payment-stream/src/lib.rs` (FeeCollectedEvent, StreamDepositEvent, etc.)
    - `campaign-funding/src/lib.rs` (ContributionMadeEvent, etc.)
  
- [ ] Implement `get_next_operation_nonce()` function
  - **File:** `payment-stream/src/lib.rs` (new, around line 500)
  
- [ ] Update `create_stream_internal()` to capture operation nonce
  - **File:** `payment-stream/src/lib.rs` (lines 785-900)
  
- [ ] Update `withdraw()` to include operation nonce
  - **File:** `payment-stream/src/lib.rs` (lines 1381-1440)
  
- [ ] Add operation nonce to `campaign-funding` contribute flow
  - **File:** `campaign-funding/src/lib.rs` (contribution logic)

#### SDK
- [ ] Update generated types to include `operation_nonce`
  - **File:** `packages/sdk/src/generated/` (regenerate)
  
- [ ] Update event decoders to parse operation nonce
  - **File:** `packages/sdk/src/utils/event-decoders.ts`
  
- [ ] Create operation correlation utility
  - **File:** `packages/sdk/src/utils/operationTracer.ts` (new)

#### Testing
- [ ] Unit tests: nonce increment verification
- [ ] Integration tests: cross-contract nonce correlation
- [ ] Edge case: nonce exhaustion (u64::MAX)

---

## Objective 2: Decimals and Asset Identity ⚠️ MISSING VALIDATION

**Status:** Partially implemented

### Current Implementation
- ✅ `exact-decimal.ts` utility for parsing
- ✅ Checked arithmetic (overflow protection)
- ✅ Token address stored per stream/campaign
- ✅ Protocol fee calculations with basis points

### Gaps
- ❌ No token decimals captured at liability creation
- ❌ No asset identity proof/validation
- ❌ Events don't include decimals (off-chain ambiguity)
- ❌ No cross-token balance verification
- ❌ Distributor doesn't validate token exists

### Required Changes

#### Contracts
- [ ] Add `TokenInfo` struct with decimals + timestamp
  - **File:** `payment-stream/src/lib.rs` (new, around line 100)
  
- [ ] Add `TokenDecimals` and `StreamTokenInfo` to `DataKey`
  - **File:** `payment-stream/src/lib.rs` (lines 13-35)
  
- [ ] Update `Stream` struct to include `token_decimals: u32`
  - **File:** `payment-stream/src/lib.rs` (lines 35-65)
  
- [ ] Update `Campaign` struct to include `token_decimals: u32`
  - **File:** `campaign-funding/src/lib.rs` (lines 210-250)
  
- [ ] Implement `verify_and_cache_token()` function
  - **File:** `payment-stream/src/lib.rs` (new, around line 500)
  
- [ ] Call token verification in `create_stream_internal()`
  - **File:** `payment-stream/src/lib.rs` (lines 785-900)
  
- [ ] Call token verification in `campaign-funding` contribute
  - **File:** `campaign-funding/src/lib.rs` (contribution logic)
  
- [ ] Add token validation to `distributor` functions
  - **File:** `distributor/src/lib.rs` (distribute_equal, distribute_weighted)
  
- [ ] Add `token_decimals` to all financial events
  - **Files:**
    - `payment-stream/src/lib.rs` (FeeCollectedEvent, StreamDepositEvent, etc.)
    - `campaign-funding/src/lib.rs` (ContributionMadeEvent, etc.)
    - `distributor/src/lib.rs` (distribution events)

#### SDK
- [ ] Add `TokenDecimals` cache to PaymentStreamClient
  - **File:** `packages/sdk/src/PaymentStreamClient.ts`
  
- [ ] Add `TokenDecimals` cache to CampaignFundingClient
  - **File:** `packages/sdk/src/CampaignFundingClient.ts`
  
- [ ] Create token validation utility
  - **File:** `packages/sdk/src/utils/tokenValidator.ts` (new)
  
- [ ] Update event decoders to validate decimals
  - **File:** `packages/sdk/src/utils/event-decoders.ts`

#### Testing
- [ ] Unit tests: token decimals caching
- [ ] Unit tests: decimal preservation across operations
- [ ] Integration tests: multi-token scenarios
- [ ] Error tests: invalid token address handling

---

## Objective 3: Fund Authorization Boundaries 🟡 INCOMPLETE

**Status:** Partially implemented

### Current Implementation
- ✅ `FeeCollector` address stored
- ✅ `Admin` authorization check
- ✅ Per-stream recipient validation
- ✅ Protocol fee tier system
- ✅ Campaign insurance pool concept

### Gaps
- ❌ No fund purpose enumeration
- ❌ Fee collector can be any address (no purpose binding)
- ❌ No spending limits per fund
- ❌ No multi-recipient authorization framework
- ❌ Insurance pool governance undefined
- ❌ Events don't specify fund purpose

### Required Changes

#### Contracts
- [ ] Create `FundPurpose` enum (ProtocolFees, Insurance, Reserve, Matching, Treasury)
  - **File:** `payment-stream/src/lib.rs` (new, around line 50)
  
- [ ] Create `FundRecipientAuth` struct
  - **File:** `payment-stream/src/lib.rs` (new, around line 60)
  
- [ ] Add fund authorization to `DataKey`
  - **File:** `payment-stream/src/lib.rs` (lines 13-35)
  
- [ ] Implement `set_fund_recipient_auth()` function
  - **File:** `payment-stream/src/lib.rs` (new, around line 550)
  
- [ ] Implement `withdraw_funds()` with authorization checks
  - **File:** `payment-stream/src/lib.rs` (new, around line 600)
  
- [ ] Create `FeeCollectedEvent` with purpose field
  - **File:** `payment-stream/src/lib.rs` (update existing event, line 170-176)
  
- [ ] Update fee collection logic to track purpose
  - **File:** `payment-stream/src/lib.rs` (fee collection in withdraw, lines 1430-1470)
  
- [ ] Update campaign insurance pool structure
  - **File:** `campaign-funding/src/lib.rs` (reserve logic, lines 800+)

#### SDK
- [ ] Add fund authorization methods to PaymentStreamClient
  - **File:** `packages/sdk/src/PaymentStreamClient.ts`
  
- [ ] Create fund withdrawal authorization interface
  - **File:** `packages/sdk/src/utils/fundAuthorization.ts` (new)

#### Testing
- [ ] Unit tests: fund authorization setup
- [ ] Unit tests: authorization expiry validation
- [ ] Unit tests: withdrawal limit enforcement
- [ ] Integration tests: multi-purpose fund scenario

---

## Objective 4: Liability Change Traceability 🔴 CRITICAL GAP

**Status:** Minimal implementation

### Current Implementation
- ✅ Contract events for major state changes
- ✅ Stream metrics tracking
- ✅ Campaign status history
- ✅ Event decoder utilities
- ✅ Audit logging framework
- ✅ BalanceWatcher utility
- ✅ Stream history utilities

### Gaps
- ❌ No transaction hash in events
- ❌ No ledger sequence in events
- ❌ No causality chain between deposits/withdrawals
- ❌ No liability snapshot before/after
- ❌ No reconciliation audit trail
- ❌ No deterministic event ordering
- ❌ No per-recipient transfer tracking

### Required Changes

#### Contracts
- [ ] Create `EventMetadata` struct
  - **File:** `payment-stream/src/lib.rs` (new, around line 100)
  
- [ ] Add deposit/withdrawal sequential counters to `DataKey`
  - **File:** `payment-stream/src/lib.rs` (lines 13-35)
  
- [ ] Update `StreamDepositedEvent` with full metadata
  - **File:** `payment-stream/src/lib.rs` (update lines 178-183)
  
- [ ] Update `StreamWithdrawnEvent` with full metadata
  - **File:** `payment-stream/src/lib.rs` (new event, after line 250)
  
- [ ] Update `ContributionMadeEvent` with full metadata
  - **File:** `campaign-funding/src/lib.rs` (update lines 365-375)
  
- [ ] Implement event hash chain for audit trail
  - **File:** `payment-stream/src/lib.rs` (new functions, around line 700)
  
- [ ] Create `LiabilityCheckpointEvent`
  - **File:** `payment-stream/src/lib.rs` (new event, after line 250)
  
- [ ] Implement checkpoint emission logic
  - **File:** `payment-stream/src/lib.rs` (new function)
  
- [ ] Add distributor per-recipient events
  - **File:** `distributor/src/lib.rs` (new events)

#### SDK
- [ ] Create reconciliation engine
  - **File:** `packages/sdk/src/utils/reconciliationEngine.ts` (new)
  
- [ ] Implement `LiabilityAuditTrail` interface
  - **File:** `packages/sdk/src/utils/reconciliationEngine.ts`
  
- [ ] Update event decoders to parse all metadata
  - **File:** `packages/sdk/src/utils/event-decoders.ts`
  
- [ ] Create event hash chain validator
  - **File:** `packages/sdk/src/utils/eventChainValidator.ts` (new)
  
- [ ] Update BalanceWatcher to track event causality
  - **File:** `packages/sdk/src/utils/BalanceWatcher.ts`

#### Testing
- [ ] Unit tests: event metadata capture
- [ ] Unit tests: hash chain construction/validation
- [ ] Integration tests: liability reconciliation
- [ ] Integration tests: event ordering verification
- [ ] End-to-end tests: full audit trail for complex workflow

---

## Cross-Cutting Tasks

### Event Versioning
- [ ] Add `event_version: u8` field to all events
- [ ] Update event decoders to handle versioning
- [ ] Create versioning documentation

### Generated Types
- [ ] Run contract type generator after all changes
  - **Command:** `npm run generate:types` (or equivalent)
- [ ] Verify all generated types include new fields

### Test Coverage
- [ ] Add tests for all new event types
- [ ] Add reconciliation tests
- [ ] Add backward compatibility tests

### Documentation
- [ ] Create operation nonce specification
- [ ] Create token decimals specification
- [ ] Create fund authorization specification
- [ ] Create audit trail and reconciliation spec
- [ ] Update README with new capabilities

### SDK Types
- [ ] Update `PaymentStreamContractEvent` union type
- [ ] Update event decoder types
- [ ] Add new utility type definitions

---

## Implementation Sequence

### Phase 1: Foundation (Weeks 1-2)
1. Implement Objective 2 (Decimals) - lowest risk, immediate value
2. Add event versioning infrastructure
3. Update SDK type generation

### Phase 2: Operation Infrastructure (Weeks 3-4)
1. Implement Objective 1 (Operation Nonces)
2. Implement Objective 4 (Traceability) - event metadata
3. Create reconciliation engine

### Phase 3: Governance (Weeks 5-6)
1. Implement Objective 3 (Fund Authorization)
2. Integrate with Operations infrastructure
3. Full test coverage

### Phase 4: Integration & Polish (Week 7)
1. End-to-end testing
2. Documentation
3. Performance optimization
4. Security audit

---

## Risk Assessment

| Objective | Risk Level | Mitigations |
|-----------|-----------|------------|
| 1. Nonces | Medium | Test nonce exhaustion, versioning from start |
| 2. Decimals | Low | Update tests incrementally, cache correctly |
| 3. Fund Auth | Medium | Clear authorization model, thorough testing |
| 4. Traceability | Medium | Hash chain verification, reconciliation engine tests |

---

## Success Criteria

### Objective 1
- [ ] Every operation has unique nonce
- [ ] Nonce appears in all related events
- [ ] Cross-contract calls correlate via nonce
- [ ] Recovery state can be determined

### Objective 2
- [ ] Token decimals captured at liability creation
- [ ] All events include decimals
- [ ] Decimal validation prevents invalid operations
- [ ] Off-chain reconciliation uses stored decimals

### Objective 3
- [ ] Fund purposes are tracked
- [ ] Authorization enforced per purpose
- [ ] Spending limits respected
- [ ] Events specify fund purpose

### Objective 4
- [ ] All events include metadata (ledger, tx_hash, nonce)
- [ ] Event hash chain validates completely
- [ ] Reconciliation engine identifies all mismatches
- [ ] Independent audit possible from events

---

## Dependencies

```
Objective 1 ──────────┐
                      ├─→ Objective 4 (both need nonce + metadata)
Objective 2           │
(independent)         │
                      │
Objective 3 ──────────┘
(depends on nonce for correlation)
```

**Recommended parallelization:**
- Phase 1: Objective 2 (independent)
- Phase 2: Objectives 1 + 4 (closely related)
- Phase 3: Objective 3 (depends on 1 + 4 infrastructure)

---

## Rollback Plan

Each objective can be rolled back independently if issues arise:

1. **Objective 1 (Nonces):** Remove operation_nonce fields from events (backward compatible if optional)
2. **Objective 2 (Decimals):** Disable token decimal validation, keep storage fields
3. **Objective 3 (Authorization):** Fall back to simple fee_collector address
4. **Objective 4 (Traceability):** Disable metadata capture, use basic events

All changes are additive to existing fields, maintaining forward compatibility.

---

**Last Updated:** 2024-12-19  
**Document Version:** 1.0
