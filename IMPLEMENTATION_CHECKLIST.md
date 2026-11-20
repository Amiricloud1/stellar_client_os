# Implementation Checklist: Four Security Objectives

Use this checklist to track progress on implementing the four security objectives across the campaign-funding, payment-stream, dispute-arbiter, and timelock contracts.

---

## Phase 1: Objective 1 — Asset Validation (Week 1-2)

### 1.1 Campaign Contract Changes
- [ ] Add `ValidatedTokenMetadata` struct to `campaign-funding/src/lib.rs`
- [ ] Add `TokenValidationError` error enum
- [ ] Add storage keys: `TokenMetadata`, `TokenWhitelist`, `CampaignTokenLocked`
- [ ] Implement `validate_token_for_escrow()` function
- [ ] Implement `whitelist_token()` function (admin-only)
- [ ] Implement `lock_campaign_token()` internal function
- [ ] Modify `deposit_to_campaign()` to validate + lock token
- [ ] Modify `create_campaign()` to check token validity

### 1.2 Testing
- [ ] Create `contracts/campaign-funding/src/test_token_validation.rs`
- [ ] Test: Valid token (USDC, 6 decimals) passes validation
- [ ] Test: Invalid decimals (0, 19) rejected with `InvalidDecimals` error
- [ ] Test: Whitelisted token skips full validation
- [ ] Test: Non-whitelisted token triggers on-chain checks
- [ ] Test: Campaign token locks after first deposit
- [ ] Test: Token cannot be changed after lock
- [ ] Test: Cached validation expires after 90 days
- [ ] Test: Transfer-restricted token rejected before deposit
- [ ] Run: `cargo test test_token_validation --lib`

### 1.3 Build & Integration
- [ ] Verify `cargo check` passes
- [ ] Build wasm: `cargo build --target wasm32-unknown-unknown --release`
- [ ] Verify artifact exists: `target/wasm32-unknown-unknown/release/campaign_funding.wasm`
- [ ] Run full test suite: `cargo test --lib`
- [ ] No regressions in existing tests

### 1.4 Documentation
- [ ] Add section to README: "Token Validation"
- [ ] Update contract spec with validation rules
- [ ] Document whitelisting process

### 1.5 Git & PR
- [ ] Create feature branch: `git checkout -b feat/objective-1-asset-validation`
- [ ] Commit with message: "feat: Objective 1 - Asset validation before escrow acceptance"
- [ ] Create PR with description:
  - [ ] Detailed summary of changes
  - [ ] Testing performed
  - [ ] Backward compatibility confirmed

---

## Phase 2: Objective 2 — Notice & Claim Periods (Week 3-4)

### 2.1 Campaign Contract Changes
- [ ] Add `RecoveryNoticeState` enum
- [ ] Add `AdminRecoveryNarrative` struct
- [ ] Add storage keys: `RecoveryNotice`, `AdminRecoveryNarratives`, `InsurancePoolLockExpiry`
- [ ] Add error codes: `RecoveryNoticePeriodActive`, `DonorClaimPeriodExpired`, `InsurancePoolLocked`
- [ ] Implement `issue_recovery_notice()` function
- [ ] Implement `contributor_claim_during_notice()` function
- [ ] Implement `execute_recovery_after_notice()` function
- [ ] Implement `assert_insurance_pool_unlocked()` helper
- [ ] Implement `verify_recovery_notices_resolved()` helper
- [ ] Modify `claim_funds()` to check notice period expired
- [ ] Modify `refund_contributor()` to respect insurance lock

### 2.2 Testing
- [ ] Create `contracts/campaign-funding/src/test_notice_periods.rs`
- [ ] Test: Admin issues recovery notice; triggers 14-day claim window
- [ ] Test: Donor can claim full balance during notice period
- [ ] Test: Multiple donors claim independently during notice
- [ ] Test: Admin cannot recover until claim deadline passes
- [ ] Test: Admin can recover after claim deadline expires
- [ ] Test: Insurance pool locked for 24 months post-campaign
- [ ] Test: Admin cannot access locked insurance pool funds
- [ ] Test: Expired claim notice allows admin recovery
- [ ] Run: `cargo test test_notice_periods --lib`

### 2.3 Build & Integration
- [ ] Verify no regressions: `cargo test --lib`
- [ ] Build wasm artifact
- [ ] Verify Objective 1 tests still pass

### 2.4 Documentation
- [ ] Add section to README: "Fund Recovery Process"
- [ ] Document 14-day notice period
- [ ] Document insurance lock mechanism

### 2.5 Git & PR
- [ ] Create feature branch: `git checkout -b feat/objective-2-notice-periods`
- [ ] Rebase on main (after Objective 1 merged)
- [ ] Commit: "feat: Objective 2 - Notice and claim periods for fund recovery"
- [ ] Create PR

---

## Phase 3: Objective 3 — Approval Governance (Week 5-6)

### 3.1 Dispute Arbiter Contract Changes
- [ ] Add `DisputeGovernance` struct
- [ ] Update `Dispute` struct to include `governance: DisputeGovernance`
- [ ] Add storage keys: `GlobalGovernance`, `ProposedGovernanceChange`, `ProposedChangeEffectiveAt`, `ActiveDisputeCount`
- [ ] Add error codes: `GovernanceChangeBlocked`, `ThresholdChangePending`, `GovernanceNotReady`
- [ ] Implement `propose_threshold_change()` function (admin-only)
- [ ] Implement `apply_governance_change()` function (admin-only)
- [ ] Modify `create_dispute()` to capture governance snapshot
- [ ] Modify `cast_vote()` to use dispute's immutable governance threshold
- [ ] Modify vote consensus logic to use `dispute.governance.approval_threshold`
- [ ] Implement `decrement_active_dispute_count()` on resolution
- [ ] Implement `increment_active_dispute_count()` on creation

### 3.2 Testing
- [ ] Create `contracts/dispute-arbiter/src/test_governance.rs`
- [ ] Test: New dispute captures current governance rules
- [ ] Test: Governance change proposed; queued for 7-day timelock
- [ ] Test: Disputes created before timelock use old governance
- [ ] Test: Disputes created after timelock use new governance
- [ ] Test: Cannot change governance while disputes are Voting
- [ ] Test: Multiple governance proposals rejected (queue one at a time)
- [ ] Test: Active dispute count increments/decrements correctly
- [ ] Test: Threshold change applies only to future disputes
- [ ] Run: `cargo test test_governance --lib`

### 3.3 Build & Integration
- [ ] Verify no regressions: `cargo test --lib`
- [ ] Build wasm artifact
- [ ] Verify Objectives 1-2 tests still pass

### 3.4 Documentation
- [ ] Add section to README: "Governance & Dispute Rules"
- [ ] Document governance snapshot mechanism
- [ ] Document 7-day timelock for threshold changes

### 3.5 Git & PR
- [ ] Create feature branch: `git checkout -b feat/objective-3-approval-governance`
- [ ] Rebase on main (after Objectives 1-2 merged)
- [ ] Commit: "feat: Objective 3 - Immutable governance snapshots for disputes"
- [ ] Create PR

---

## Phase 4: Objective 4 — Dispute Blocking (Week 7-8)

### 4.1 Payment Stream Contract Changes
- [ ] Add `QueuedResolution` struct
- [ ] Add `DisputeSnapshot` struct
- [ ] Add storage keys: `ActiveDispute`, `QueuedResolution`, `DisputeSnapshot`, `DisputeArbiter`
- [ ] Add error codes: `DisputePending`, `ResolutionNotReady`, `InvalidDisputeOutcome`, `NoActiveDispute`, `NoQueuedResolution`, `ResolutionAlreadyExecuted`
- [ ] Implement `assert_no_active_dispute()` guard function
- [ ] Implement `initiate_dispute()` function
- [ ] Implement `resolve_dispute()` function
- [ ] Implement `execute_queued_resolution()` function
- [ ] Implement `cancel_dispute()` function (sender-only)
- [ ] Modify `withdraw()` to check `assert_no_active_dispute()`
- [ ] Modify `pause_stream()` to check `assert_no_active_dispute()`
- [ ] Modify `release_stream()` to check `assert_no_active_dispute()`
- [ ] Modify `claim_refund()` to check `assert_no_active_dispute()`
- [ ] Add `set_dispute_arbiter()` to configure arbiter contract address

### 4.2 Testing
- [ ] Create `contracts/payment-stream/src/test_dispute_blocking.rs`
- [ ] Test: Initiating dispute blocks recipient withdrawal
- [ ] Test: Initiating dispute blocks stream modifications (pause, release)
- [ ] Test: Queued resolution cannot execute before 48h timelock
- [ ] Test: Resolution executes correctly after 48h
- [ ] Test: Sender can cancel dispute early
- [ ] Test: Dispute outcome snapshot preserves stream state
- [ ] Test: Multiple disputes on same stream prevented
- [ ] Test: Deterministic dispute expiry (7 days from resolution)
- [ ] Test: Expired dispute can be force-closed
- [ ] Run: `cargo test test_dispute_blocking --lib`

### 4.3 Integration Testing
- [ ] Create `contracts/payment-stream/src/test_e2e_dispute.rs`
- [ ] Test: Complete workflow (stream → dispute → resolution → payout)
- [ ] Test: Multi-contract interaction (stream + arbiter)
- [ ] Run: `cargo test test_e2e_dispute --lib`

### 4.4 Build & Integration
- [ ] Verify no regressions: `cargo test --lib`
- [ ] Build wasm artifact
- [ ] Verify Objectives 1-3 tests still pass
- [ ] Run integration tests across all contracts

### 4.5 Documentation
- [ ] Add section to README: "Dispute Management"
- [ ] Document dispute blocking mechanism
- [ ] Document 48-hour timelock
- [ ] Document 7-day expiry window

### 4.6 Git & PR
- [ ] Create feature branch: `git checkout -b feat/objective-4-dispute-blocking`
- [ ] Rebase on main (after Objectives 1-3 merged)
- [ ] Commit: "feat: Objective 4 - Dispute blocking and timelock resolution"
- [ ] Create PR

---

## Phase 5: Integration & Final Release (Week 9)

### 5.1 Cross-Contract Integration
- [ ] Verify campaign contract integrates with dispute-arbiter
- [ ] Verify payment-stream integrates with dispute-arbiter
- [ ] Verify timelock contract integration (if needed)
- [ ] Create comprehensive integration test
- [ ] Run: `cargo test --lib --all`

### 5.2 Security Audit
- [ ] Code review: Auth checks on all functions
- [ ] Code review: Overflow/underflow handling
- [ ] Code review: Reentrancy analysis
- [ ] Code review: Storage key collisions
- [ ] Security audit: Check for common vulnerabilities
- [ ] Fuzzing: Test with random inputs (if available)

### 5.3 Reproducible Build Verification
- [ ] Build in clean Docker container
- [ ] Verify wasm artifacts are deterministic
- [ ] Compare with CI build artifacts
- [ ] Document build environment and toolchain versions

### 5.4 Documentation Updates
- [ ] Update README with all four objectives
- [ ] Update CONTRIBUTING.md
- [ ] Add SECURITY_OBJECTIVES_IMPLEMENTATION.md with details
- [ ] Update threat model (if applicable)
- [ ] Create runbook for operators (if needed)

### 5.5 Deployment Preparation
- [ ] Create comprehensive PR with all changes
- [ ] Get 2+ code review approvals
- [ ] Pass all CI checks
- [ ] Merge to main
- [ ] Tag release: `v1.0.0-security-objectives`
- [ ] Deploy to testnet
- [ ] Verify all features work on testnet
- [ ] Document deployment steps

### 5.6 Release PR Checklist
- [ ] PR title: "feat: Implement all four security objectives"
- [ ] PR description includes:
  - [ ] Summary of changes
  - [ ] Risk analysis
  - [ ] Testing results
  - [ ] Backward compatibility note
  - [ ] Migration path (if any)
  - [ ] Deployment instructions
- [ ] All checks passing:
  - [ ] CI/CD pipeline
  - [ ] Security scanning
  - [ ] Artifact reproducibility
- [ ] Approvals from:
  - [ ] Security team
  - [ ] Tech lead
  - [ ] Product lead

---

## Success Metrics

### Code Quality
- [ ] Test coverage >95% for modified code
- [ ] No regressions in existing tests
- [ ] All new tests pass
- [ ] No compiler warnings

### Security
- [ ] No P1 findings in security audit
- [ ] All error codes properly handled
- [ ] No auth bypass vectors
- [ ] No arithmetic overflow issues

### Documentation
- [ ] All functions have doc comments
- [ ] README updated with new features
- [ ] Threat model updated (if needed)
- [ ] Operator runbooks provided

### Performance
- [ ] No degradation in contract execution time
- [ ] Storage footprint acceptable
- [ ] Caching strategy effective (90-day TTL for tokens)

---

## Timeline Tracking

| Phase | Objective | Start | End | Status | Notes |
|-------|-----------|-------|-----|--------|-------|
| 1 | Asset Validation | Week 1 | Week 2 | ⬜ Not Started | |
| 2 | Notice & Claim Periods | Week 3 | Week 4 | ⬜ Blocked by Ph1 | |
| 3 | Approval Governance | Week 5 | Week 6 | ⬜ Blocked by Ph2 | |
| 4 | Dispute Blocking | Week 7 | Week 8 | ⬜ Blocked by Ph3 | |
| 5 | Integration & Release | Week 9 | Week 9 | ⬜ Blocked by Ph4 | |

**Legend**: ⬜ Not Started | 🟡 In Progress | 🟢 Complete | ❌ Blocked

---

## Rollback Plan

If any phase encounters critical issues:

1. **Stop work** on that phase
2. **Revert last commit**: `git revert HEAD`
3. **Investigate root cause**
4. **Fix and retry**, or
5. **Escalate** to tech lead

No phase should be merged without passing all tests and security review.

---

## Sign-Off

Implement these phases sequentially. Do not proceed to the next phase until the previous one is complete and merged to main.

**Project Lead**: _______________  **Date**: _______________

**Security Lead**: _______________  **Date**: _______________

**Tech Lead**: _______________  **Date**: _______________

