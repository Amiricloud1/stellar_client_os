# Implementation Roadmap: Four Security Objectives

This document outlines a systematic approach to implementing the four security objectives identified in `SECURITY_OBJECTIVES.md`. Each objective must be implemented and tested sequentially to ensure correctness and prevent regressions.

## Implementation Order & Dependencies

```
Objective 1 (Asset Validation)
     ↓
Objective 2 (Notice & Claim Periods)
     ↓
Objective 3 (Approval Threshold Governance)
     ↓
Objective 4 (Timelock & Dispute Blocking)
```

---

## Phase 1: Objective 1 — Asset Validation (Week 1-2)

### What: Reject Assets with Transfer, Decimal, or Administrative Restrictions

**Goal**: Ensure every token accepted by a campaign meets strict safety criteria before the first deposit.

### Changes Required

#### 1.1 Campaign Contract (`contracts/campaign-funding/src/lib.rs`)

**Add these types:**

```rust
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedTokenMetadata {
    pub token: Address,
    pub decimals: u32,
    pub is_whitelisted: bool,
    pub validated_at: u64,
}

pub enum TokenValidationError {
    InvalidDecimals = 1,
    MutableSupply = 2,
    TransferRestricted = 3,
    NotWhitelisted = 4,
    ValidationExpired = 5,
}

pub enum DataKey {
    // ... existing keys ...
    TokenMetadata(Address),          // Cached validation
    TokenWhitelist(Address),         // Admin-approved tokens
    CampaignTokenLocked(u64),       // Token immutability flag
}
```

**Add these functions:**

```rust
impl CampaignFundingContract {
    /// Validate a token before accepting it in a campaign.
    pub fn validate_token_for_escrow(
        env: Env,
        token: Address,
    ) -> Result<ValidatedTokenMetadata, TokenValidationError> {
        // 1. Check whitelist
        // 2. Verify decimals (6 or 18 only)
        // 3. Test transfer capability
        // 4. Cache result (90-day TTL)
    }

    /// Whitelist a token for campaign use (admin only).
    pub fn whitelist_token(
        env: Env,
        token: Address,
        admin: Address,
    ) -> Result<(), Error> {
        // Verify admin auth
        // Mark token as whitelisted
        // Emit event
    }

    /// Lock campaign to a specific token after first deposit.
    fn lock_campaign_token(env: &Env, campaign_id: u64, token: &Address) {
        // Set immutable token association
        // Prevent token switching
    }
}
```

**Modify `deposit_to_campaign`:**

```rust
pub fn deposit_to_campaign(
    env: Env,
    campaign_id: u64,
    contributor: Address,
    amount: i128,
) -> Result<(), Error> {
    // NEW: Validate token before accepting deposit
    let campaign = get_campaign(&env, campaign_id)?;
    validate_token_for_escrow(&env, &campaign.token)?;
    
    // NEW: Lock token on first deposit
    lock_campaign_token(&env, campaign_id, &campaign.token);
    
    // ... existing deposit logic ...
}
```

#### 1.2 Testing

**File:** `contracts/campaign-funding/src/test_token_validation.rs` (new)

Tests required:
1. ✅ Valid token (USDC with 6 decimals) passes validation
2. ✅ Invalid decimals (0 or 19) rejected
3. ✅ Whitelisted token bypasses full validation
4. ✅ Non-whitelisted token triggers on-chain checks
5. ✅ Campaign token locks after first deposit
6. ✅ Cached validation expires after 90 days
7. ✅ Transfer-restricted token rejected before deposit

**Run tests:**

```bash
cd contracts/campaign-funding
cargo test test_token_validation --features soroban-sdk --lib
```

#### 1.3 Deployment

1. Update `contracts/campaign-funding/Cargo.toml` if needed (no new deps)
2. Build wasm: `cargo build --target wasm32-unknown-unknown --release`
3. Create feature branch: `git checkout -b feat/objective-1-asset-validation`
4. Commit changes with clear message:
   ```
   feat: Objective 1 - Asset validation before escrow acceptance
   
   - Add token metadata validation (decimals, transfer restrictions)
   - Implement token whitelist with admin control
   - Lock campaign to single token after first deposit
   - Cache validation for 90 days
   
   Fixes: Asset acceptance without security checks
   ```

---

## Phase 2: Objective 2 — Notice & Claim Periods (Week 3-4)

### What: Define Notice and Claim Periods; Prevent Administrator Recovery of Active Balances

**Goal**: Protect donors from surprise fund recovery; give them time to reclaim before admin withdrawal.

### Changes Required

#### 2.1 Campaign Contract (`contracts/campaign-funding/src/lib.rs`)

**Add these types:**

```rust
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecoveryNoticeState {
    /// No recovery notice issued
    None,
    /// Notice issued; claim period active
    Pending {
        issued_at: u64,
        claim_deadline: u64,
    },
    /// Claim period expired; ready for admin recovery
    Expired,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminRecoveryNarrative {
    /// Donor/contributor address
    pub contributor: Address,
    /// Campaign ID
    pub campaign_id: u64,
    /// Recovery amount
    pub amount: i128,
    /// Notice state
    pub notice_state: RecoveryNoticeState,
    /// Last claim attempt time
    pub last_claim_attempt: u64,
}

pub enum DataKey {
    // ... existing keys ...
    RecoveryNotice(u64, Address),           // Per-campaign, per-donor
    AdminRecoveryNarratives(u64),          // Pending recoveries
    InsurancePoolLockExpiry(u64),          // Campaign insurance lock time
}
```

**Add error codes:**

```rust
pub enum Error {
    // ... existing ...
    RecoveryNoticePeriodActive = 100,       // Can't recover yet; claim period open
    DonorClaimPeriodExpired = 101,          // Donor missed claim deadline
    InsurancePoolLocked = 102,              // Funds locked for 24 months post-campaign
}
```

**Add these functions:**

```rust
impl CampaignFundingContract {
    /// Initiate admin recovery with mandatory 14-day donor claim window.
    pub fn issue_recovery_notice(
        env: Env,
        campaign_id: u64,
        contributor: Address,
        admin: Address,
    ) -> Result<(), Error> {
        // Verify admin auth
        // Check campaign status
        // Issue notice with 14-day claim deadline
        // Emit event
    }

    /// Allow donors to claim their balance during notice period.
    pub fn contributor_claim_during_notice(
        env: Env,
        campaign_id: u64,
        contributor: Address,
    ) -> Result<i128, Error> {
        // Verify notice is pending
        // Transfer balance to contributor
        // Mark as claimed
        // Emit event
    }

    /// Execute admin recovery ONLY after claim deadline passed.
    pub fn execute_recovery_after_notice(
        env: Env,
        campaign_id: u64,
        contributor: Address,
        admin: Address,
    ) -> Result<(), Error> {
        // Check notice is expired
        // Verify no active disputes
        // Transfer to admin (or insurance pool)
        // Record recovery
    }

    /// Check if insurance pool funds are locked (24-month post-campaign hold).
    fn assert_insurance_pool_unlocked(env: &Env, campaign_id: u64) -> Result<(), Error> {
        // Get campaign completion time
        // Check 24-month lock expiry
        // Reject if locked
    }
}
```

**Modify `claim_funds` (from existing code):**

```rust
pub fn claim_funds(
    env: Env,
    campaign_id: u64,
    creator: Address,
) -> Result<i128, Error> {
    // NEW: Verify no active recovery notices (all claimed or expired)
    verify_recovery_notices_resolved(&env, campaign_id)?;
    
    // NEW: Verify 14-day notice period has elapsed since campaign end
    let campaign = get_campaign(&env, campaign_id)?;
    let now = env.ledger().timestamp();
    let notice_expiry = campaign.deadline.saturating_add(14 * 86_400); // 14 days
    if now < notice_expiry {
        return Err(Error::RecoveryNoticePeriodActive);
    }
    
    // ... existing claim logic ...
}
```

#### 2.2 Testing

**File:** `contracts/campaign-funding/src/test_notice_periods.rs` (new)

Tests required:
1. ✅ Admin issues recovery notice; triggers 14-day claim window
2. ✅ Donor can claim full balance during notice period
3. ✅ Admin cannot recover until claim deadline passes
4. ✅ Multiple donors can claim independently during notice period
5. ✅ Insurance pool locked for 24 months after campaign completion
6. ✅ Admin cannot claim if donor has claimed first
7. ✅ Expired claim notice allows admin recovery

**Run tests:**

```bash
cd contracts/campaign-funding
cargo test test_notice_periods --features soroban-sdk --lib
```

#### 2.3 Deployment

1. Create feature branch: `git checkout -b feat/objective-2-notice-periods`
2. Commit changes:
   ```
   feat: Objective 2 - Notice and claim periods for fund recovery
   
   - Add 14-day mandatory notice before admin recovery
   - Enable donor early claim during notice period
   - Lock insurance pool for 24 months post-campaign
   - Prevent admin recovery of active or claimable balances
   
   Fixes: Unprotected administrative fund recovery
   ```

---

## Phase 3: Objective 3 — Approval Threshold Governance (Week 5-6)

### What: Bound Approval Thresholds and Freeze Changes After Fundraising Begins

**Goal**: Lock dispute voting rules at dispute creation; prevent retroactive threshold changes.

### Changes Required

#### 3.1 Dispute Arbiter Contract (`contracts/dispute-arbiter/src/lib.rs`)

**Add these types:**

```rust
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeGovernance {
    /// Approval votes required for consensus (e.g., 3 of 5)
    pub approval_threshold: u32,
    /// Voting period in seconds
    pub voting_period_secs: u64,
    /// Evidence submission deadline in seconds
    pub evidence_deadline_secs: u64,
    /// Timestamp when governance snapshot was taken
    pub snapshot_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispute {
    // ... existing fields ...
    /// Immutable governance rules for this dispute (captured at creation)
    pub governance: DisputeGovernance,
}

pub enum DataKey {
    // ... existing ...
    GlobalGovernance,                 // Current default governance
    ProposedGovernanceChange,        // Pending threshold proposal
    ProposedChangeEffectiveAt,       // When change takes effect
    ActiveDisputeCount,              // Number of disputes in Voting state
}

pub enum ArbiterError {
    // ... existing ...
    GovernanceChangeBlocked = 100,    // Cannot change during active disputes
    ThresholdChangePending = 101,     // Change already proposed, waiting
    GovernanceNotReady = 102,         // Proposed change not yet effective
}
```

**Add these functions:**

```rust
impl DisputeArbiterContract {
    /// Propose a governance threshold change (admin only).
    /// Changes take effect only for NEW disputes after 7-day timelock.
    pub fn propose_threshold_change(
        env: Env,
        admin: Address,
        new_threshold: u32,
        new_voting_period_secs: u64,
        new_evidence_deadline_secs: u64,
    ) -> Result<(), ArbiterError> {
        admin.require_auth();
        
        // Verify proposed values are reasonable
        if new_threshold > REQUIRED_ARBITERS {
            return Err(ArbiterError::GovernanceNotReady);
        }
        
        // Check no change already pending
        if env.storage().instance().has(&DataKey::ProposedGovernanceChange) {
            return Err(ArbiterError::ThresholdChangePending);
        }
        
        let new_governance = DisputeGovernance {
            approval_threshold: new_threshold,
            voting_period_secs: new_voting_period_secs,
            evidence_deadline_secs: new_evidence_deadline_secs,
            snapshot_at: env.ledger().timestamp() + (7 * 86_400), // 7-day timelock
        };
        
        env.storage()
            .instance()
            .set(&DataKey::ProposedGovernanceChange, &new_governance);
        env.storage()
            .instance()
            .set(&DataKey::ProposedChangeEffectiveAt, &new_governance.snapshot_at);
        
        // Emit event
        env.events().publish(
            ("GovernanceChangeProposed",),
            (admin, new_threshold, env.ledger().timestamp()),
        );
        
        Ok(())
    }

    /// Apply pending governance change (can only apply after timelock).
    pub fn apply_governance_change(env: Env, admin: Address) -> Result<(), ArbiterError> {
        admin.require_auth();
        
        let new_governance: DisputeGovernance = env
            .storage()
            .instance()
            .get(&DataKey::ProposedGovernanceChange)
            .ok_or(ArbiterError::ThresholdChangePending)?;
        
        // Check timelock has passed
        if env.ledger().timestamp() < new_governance.snapshot_at {
            return Err(ArbiterError::GovernanceNotReady);
        }
        
        // Check no active disputes
        let active_count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ActiveDisputeCount)
            .unwrap_or(0);
        if active_count > 0 {
            return Err(ArbiterError::GovernanceChangeBlocked);
        }
        
        // Apply change
        env.storage()
            .instance()
            .set(&DataKey::GlobalGovernance, &new_governance);
        env.storage()
            .instance()
            .remove(&DataKey::ProposedGovernanceChange);
        
        // Emit event
        env.events().publish(
            ("GovernanceChangeApplied",),
            (admin, new_governance.approval_threshold),
        );
        
        Ok(())
    }

    /// Create dispute with immutable governance snapshot.
    pub fn create_dispute(
        env: Env,
        milestone_id: u64,
        escrow_id: u64,
        client: Address,
        freelancer: Address,
        assigned_arbiters: Vec<Address>,
    ) -> Result<u64, ArbiterError> {
        // ... existing validation ...
        
        // NEW: Capture governance snapshot at dispute creation
        let governance = env
            .storage()
            .instance()
            .get(&DataKey::GlobalGovernance)
            .unwrap_or(DisputeGovernance {
                approval_threshold: CONSENSUS_THRESHOLD,
                voting_period_secs: DEFAULT_VOTING_PERIOD_SECS,
                evidence_deadline_secs: DEFAULT_VOTING_PERIOD_SECS,
                snapshot_at: env.ledger().timestamp(),
            });
        
        let dispute = Dispute {
            // ... existing fields ...
            governance: governance.clone(),
        };
        
        // Increment active dispute count
        let active_count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ActiveDisputeCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::ActiveDisputeCount, &(active_count + 1));
        
        env.storage().persistent().set(&DataKey::Dispute(count), &dispute);
        
        Ok(count)
    }

    /// Resolve dispute and decrement active count.
    pub fn cast_vote(...) -> Result<(), ArbiterError> {
        // ... existing voting logic ...
        
        // When dispute resolves (reaches consensus):
        if resolved {
            let active_count: u64 = env
                .storage()
                .instance()
                .get(&DataKey::ActiveDisputeCount)
                .unwrap_or(0);
            if active_count > 0 {
                env.storage()
                    .instance()
                    .set(&DataKey::ActiveDisputeCount, &(active_count - 1));
            }
        }
        
        Ok(())
    }
}
```

**Modify vote consensus check:**

```rust
// OLD: Used global CONSENSUS_THRESHOLD
// NEW: Use dispute's immutable governance snapshot
let threshold = dispute.governance.approval_threshold;

let resolved = if dispute.votes_for_approve >= threshold {
    // ...
} else if dispute.votes_for_reject >= threshold {
    // ...
} else if dispute.votes_for_evidence >= threshold {
    // ...
}
```

#### 3.2 Testing

**File:** `contracts/dispute-arbiter/src/test_governance.rs` (new)

Tests required:
1. ✅ New dispute captures current governance rules
2. ✅ Governance change proposed; queued for 7-day timelock
3. ✅ New disputes created before timelock use old governance
4. ✅ New disputes created after timelock use new governance
5. ✅ Cannot change governance while disputes are active (Voting state)
6. ✅ Multiple governance proposals rejected (only one pending)
7. ✅ Active dispute count increments/decrements correctly

**Run tests:**

```bash
cd contracts/dispute-arbiter
cargo test test_governance --features soroban-sdk --lib
```

#### 3.3 Deployment

1. Create feature branch: `git checkout -b feat/objective-3-approval-governance`
2. Commit changes:
   ```
   feat: Objective 3 - Immutable governance snapshots for disputes
   
   - Capture governance rules at dispute creation time
   - Prevent threshold changes during active disputes
   - Implement 7-day timelock for governance updates
   - Track active dispute count to block mid-voting changes
   
   Fixes: Retroactive approval threshold manipulation
   ```

---

## Phase 4: Objective 4 — Timelock & Dispute Blocking (Week 7-8)

### What: Block Irreversible Payout During Valid Challenge and Define Deterministic Expiry

**Goal**: Prevent fund payouts while disputes are pending; queue resolutions through timelock.

### Changes Required

#### 4.1 Payment Stream Contract (`contracts/payment-stream/src/lib.rs`)

**Add these types:**

```rust
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueuedResolution {
    pub dispute_id: u64,
    pub stream_id: u64,
    pub recipient_amount: i128,
    pub sender_amount: i128,
    pub execute_after: u64,
    pub executed: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeSnapshot {
    /// Dispute ID from arbiter contract
    pub dispute_id: u64,
    /// Stream state at dispute creation
    pub stream_status: StreamStatus,
    pub balance_at_dispute: i128,
    pub withdrawn_at_dispute: i128,
    /// Dispute outcome
    pub arbiter_decision: DisputeState,
    /// When resolution becomes executable
    pub executable_at: u64,
}

pub enum DataKey {
    // ... existing ...
    ActiveDispute(u64),              // Current dispute ID for stream
    QueuedResolution(u64),           // Queued resolution by stream ID
    DisputeSnapshot(u64, u64),       // (stream_id, dispute_id)
}

pub enum StreamError {
    // ... existing ...
    DisputePending = 200,            // Stream has active dispute
    ResolutionNotReady = 201,        // Queued resolution in timelock
    InvalidDisputeOutcome = 202,     // Arbiter decision invalid
}
```

**Add guard function:**

```rust
fn assert_no_active_dispute(env: &Env, stream_id: u64) -> Result<(), StreamError> {
    if env.storage().persistent().has(&DataKey::ActiveDispute(stream_id)) {
        return Err(StreamError::DisputePending);
    }
    Ok(())
}
```

**Add these functions:**

```rust
impl PaymentStreamContract {
    /// Mark stream as disputed; block all payouts.
    pub fn initiate_dispute(
        env: Env,
        stream_id: u64,
        dispute_id: u64,
        initiator: Address,
    ) -> Result<(), StreamError> {
        initiator.require_auth();
        
        let stream: Stream = env
            .storage()
            .persistent()
            .get(&DataKey::Stream(stream_id))
            .ok_or(StreamError::StreamNotFound)?;
        
        // Only recipient or sender can initiate
        if initiator != stream.recipient && initiator != stream.sender {
            return Err(StreamError::Unauthorized);
        }
        
        // Verify no existing dispute
        if env.storage().persistent().has(&DataKey::ActiveDispute(stream_id)) {
            return Err(StreamError::DisputePending);
        }
        
        // Create dispute snapshot
        let snapshot = DisputeSnapshot {
            dispute_id,
            stream_status: stream.status.clone(),
            balance_at_dispute: stream.balance,
            withdrawn_at_dispute: stream.withdrawn_amount,
            arbiter_decision: DisputeState::Voting,
            executable_at: env.ledger().timestamp() + 48 * 3600, // 48h timelock
        };
        
        env.storage()
            .persistent()
            .set(&DataKey::ActiveDispute(stream_id), &dispute_id);
        env.storage()
            .persistent()
            .set(&DataKey::DisputeSnapshot(stream_id, dispute_id), &snapshot);
        
        // Transition stream to Disputed
        let mut updated_stream = stream;
        updated_stream.status = StreamStatus::Disputed;
        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &updated_stream);
        
        // Emit event
        env.events().publish(
            ("DisputeInitiated",),
            (stream_id, dispute_id, initiator),
        );
        
        Ok(())
    }

    /// Resolve dispute from arbiter and queue payout (requires 48h timelock).
    pub fn resolve_dispute(
        env: Env,
        stream_id: u64,
        dispute_id: u64,
        arbiter_decision: DisputeState,
        recipient_recovery: i128,
        sender_recovery: i128,
    ) -> Result<(), StreamError> {
        // Only callable by dispute arbiter contract (auth check)
        let arbiter = env.storage()
            .instance()
            .get(&DataKey::DisputeArbiter)
            .ok_or(StreamError::Unauthorized)?;
        arbiter.require_auth();
        
        let active_dispute: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::ActiveDispute(stream_id))
            .ok_or(StreamError::NoActiveDispute)?;
        
        if active_dispute != dispute_id {
            return Err(StreamError::InvalidDisputeId);
        }
        
        // Validate decision is terminal (Approved, Rejected, TimedOut)
        match arbiter_decision {
            DisputeState::Voting | DisputeState::EvidenceRequested => {
                return Err(StreamError::InvalidDisputeOutcome);
            }
            _ => {}
        }
        
        // Queue resolution with 48h timelock
        let queued = QueuedResolution {
            dispute_id,
            stream_id,
            recipient_amount: recipient_recovery,
            sender_amount: sender_recovery,
            execute_after: env.ledger().timestamp() + 48 * 3600,
            executed: false,
        };
        
        env.storage()
            .persistent()
            .set(&DataKey::QueuedResolution(stream_id), &queued);
        
        // Emit event
        env.events().publish(
            ("DisputeResolved",),
            (stream_id, dispute_id, arbiter_decision, execute_after),
        );
        
        Ok(())
    }

    /// Execute queued resolution after 48h timelock passes.
    pub fn execute_queued_resolution(
        env: Env,
        stream_id: u64,
    ) -> Result<(), StreamError> {
        let mut queued: QueuedResolution = env
            .storage()
            .persistent()
            .get(&DataKey::QueuedResolution(stream_id))
            .ok_or(StreamError::NoQueuedResolution)?;
        
        if queued.executed {
            return Err(StreamError::ResolutionAlreadyExecuted);
        }
        
        // Verify timelock has elapsed
        if env.ledger().timestamp() < queued.execute_after {
            return Err(StreamError::ResolutionNotReady);
        }
        
        // Transfer payouts
        let mut stream: Stream = env
            .storage()
            .persistent()
            .get(&DataKey::Stream(stream_id))
            .ok_or(StreamError::StreamNotFound)?;
        
        let token_client = token::Client::new(&env, &stream.token);
        
        if queued.recipient_amount > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &stream.recipient,
                &queued.recipient_amount,
            );
        }
        
        if queued.sender_amount > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &stream.sender,
                &queued.sender_amount,
            );
        }
        
        // Mark as executed and clear dispute
        queued.executed = true;
        env.storage()
            .persistent()
            .set(&DataKey::QueuedResolution(stream_id), &queued);
        env.storage()
            .persistent()
            .remove(&DataKey::ActiveDispute(stream_id));
        
        // Reset stream status
        stream.status = StreamStatus::Active;
        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &stream);
        
        // Emit event
        env.events().publish(
            ("ResolutionExecuted",),
            (stream_id, queued.dispute_id),
        );
        
        Ok(())
    }

    /// Sender-initiated early cancellation of dispute.
    pub fn cancel_dispute(
        env: Env,
        stream_id: u64,
        sender: Address,
    ) -> Result<(), StreamError> {
        sender.require_auth();
        
        let stream: Stream = env
            .storage()
            .persistent()
            .get(&DataKey::Stream(stream_id))
            .ok_or(StreamError::StreamNotFound)?;
        
        if sender != stream.sender {
            return Err(StreamError::Unauthorized);
        }
        
        let active_dispute: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::ActiveDispute(stream_id))
            .ok_or(StreamError::NoActiveDispute)?;
        
        // Clear dispute and queued resolution
        env.storage()
            .persistent()
            .remove(&DataKey::ActiveDispute(stream_id));
        env.storage()
            .persistent()
            .remove(&DataKey::QueuedResolution(stream_id));
        
        // Reset stream status
        let mut updated_stream = stream;
        updated_stream.status = StreamStatus::Active;
        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &updated_stream);
        
        // Emit event
        env.events().publish(
            ("DisputeCancelled",),
            (stream_id, active_dispute),
        );
        
        Ok(())
    }
}
```

**Modify all fund-moving operations:**

```rust
// Add this guard to: withdraw, pause, release, claim_refund, etc.

pub fn withdraw(env: Env, stream_id: u64, recipient: Address, amount: i128) -> Result<(), StreamError> {
    recipient.require_auth();
    
    // NEW: Block withdrawal if dispute is active or resolution queued
    assert_no_active_dispute(&env, stream_id)?;
    
    let queued: Option<QueuedResolution> = env
        .storage()
        .persistent()
        .get(&DataKey::QueuedResolution(stream_id));
    
    if queued.is_some() && !queued.unwrap().executed {
        return Err(StreamError::ResolutionNotReady);
    }
    
    // ... existing withdrawal logic ...
}
```

#### 4.2 Testing

**File:** `contracts/payment-stream/src/test_dispute_blocking.rs` (new)

Tests required:
1. ✅ Initiating dispute blocks recipient withdrawal
2. ✅ Initiating dispute blocks stream modifications
3. ✅ Queued resolution cannot execute before 48h timelock
4. ✅ Resolution executes correctly after 48h
5. ✅ Sender can cancel dispute early (before timelock expires)
6. ✅ Dispute outcome snapshot preserves stream state
7. ✅ Multiple disputes on same stream prevented
8. ✅ Deterministic dispute expiry (7 days from arbiter resolution)
9. ✅ Expired dispute can be force-closed by anyone

**Run tests:**

```bash
cd contracts/payment-stream
cargo test test_dispute_blocking --features soroban-sdk --lib
```

#### 4.3 Integration Test

**File:** `contracts/payment-stream/src/test_e2e_dispute.rs` (new)

End-to-end scenario:

```rust
#[test]
fn test_e2e_stream_dispute_workflow() {
    let env = Env::default();
    // Setup stream
    // Create dispute via arbiter
    // Verify stream is locked during voting
    // Arbiters vote -> consensus
    // Resolution queued with 48h timelock
    // Time advance past timelock
    // Execute resolution
    // Verify payouts delivered
}
```

#### 4.4 Deployment

1. Create feature branch: `git checkout -b feat/objective-4-dispute-blocking`
2. Commit changes:
   ```
   feat: Objective 4 - Dispute blocking and timelock resolution
   
   - Block irreversible payouts during active disputes
   - Queue dispute resolutions with mandatory 48h timelock
   - Capture immutable dispute snapshot at creation
   - Allow sender-initiated early dispute cancellation
   - Define deterministic 7-day dispute expiry window
   
   Fixes: Unprotected fund releases during valid challenges
   ```

---

## Final Integration & Release

### 4.5 Create Integration Test

**File:** `contracts/integration/tests/test_all_objectives.rs` (new)

Comprehensive test exercising all four objectives together:

```rust
#[test]
fn test_complete_security_objectives_flow() {
    // 1. Create campaign with validated token
    // 2. Donations accepted; contributor notices issued
    // 3. Dispute created; governance frozen
    // 4. Resolution queued through timelock
    // 5. Verify all blocking mechanisms work together
}
```

### 4.6 Security Audit

1. Code review: All contracts reviewed for auth checks, overflow, reentrancy
2. Fuzzing: Test arithmetic with random inputs
3. Formal analysis: Dispute state machine transitions
4. Documentation: Update README and contributing guide

### 4.7 Release PR

Create comprehensive PR:

```markdown
## Summary

Implement four critical security objectives for campaign funding and payment stream contracts:

1. **Objective 1**: Asset validation before escrow acceptance
2. **Objective 2**: Notice and claim periods for fund recovery
3. **Objective 3**: Immutable governance snapshots for disputes
4. **Objective 4**: Timelock and dispute blocking for payouts

## Changes

- `contracts/campaign-funding/src/lib.rs`: Token validation, notice periods
- `contracts/dispute-arbiter/src/lib.rs`: Governance snapshots
- `contracts/payment-stream/src/lib.rs`: Dispute blocking, timelock
- Tests: Comprehensive coverage for all objectives

## Testing

- All existing tests pass
- New test suites: 28 additional tests
- Integration test: End-to-end workflow
- Coverage: >95% for modified code

## Breaking Changes

None. Contracts remain backward compatible; new features are opt-in.

## Review Checklist

- [ ] All tests pass locally
- [ ] No regressions in existing functionality
- [ ] Wasm artifacts build deterministically
- [ ] Security audit completed
- [ ] Documentation updated
```

---

## Timeline Summary

| Phase | Objective | Duration | Dependencies |
|-------|-----------|----------|--------------|
| 1 | Asset Validation | 2 weeks | None |
| 2 | Notice & Claim Periods | 2 weeks | Objective 1 |
| 3 | Approval Governance | 2 weeks | Objectives 1-2 |
| 4 | Dispute Blocking | 2 weeks | Objectives 1-3 |
| **Total** | **All Four** | **8 weeks** | Sequential |

---

## Success Criteria

- ✅ All tests pass (existing + new)
- ✅ No regressions in feature functionality
- ✅ Wasm artifacts build reproducibly
- ✅ Security audit completed with no P1 findings
- ✅ Documentation updated (README, CONTRIBUTING, contract specs)
- ✅ PR approved by 2+ reviewers
- ✅ Merged to main and deployed to testnet

---

## Questions & Escalations

If you encounter blocking issues during implementation:

1. **Arithmetic overflow**: Use `saturating_*` or `checked_*` methods
2. **Storage key collisions**: Add campaign_id or stream_id to key tuple
3. **Auth timeouts**: Verify contract auth is called within signed tx
4. **Ledger TTL**: Use `bump_ttl()` helper for persistent entries

Contact: Security team or create issue with `[OBJECTIVE-n]` prefix

