# Technical Analysis: Four Critical Objectives for Stellar Client OS Contracts

**Date:** 2024-12-19  
**Analysis Scope:** Payment Stream, Campaign Funding, and Distributor Contracts  
**Target:** Soroban Smart Contracts + SDK Layer

---

## Executive Summary

This document analyzes the current implementation state of four critical objectives for reliable financial operations in the Stellar Client OS ecosystem:

1. **Operation Nonces & Recovery States** for multi-contract workflows
2. **Decimal & Asset Identity Preservation** in liability creation
3. **Protocol-Owned Fund Authorization Boundaries** independent from user escrow
4. **Liability Change Traceability** via stable operation & event references

Each objective identifies implementation gaps, affected files, and specific recommendations.

---

## Objective 1: Operation Nonces and Recovery States for Multi-Contract Workflows

### Current State

**What's Implemented:**
- ✅ Individual stream IDs (u64 sequential counters) in payment-stream contract
- ✅ Campaign IDs (u64 sequential counters) in campaign-funding contract
- ✅ Dispute IDs (u64 sequential counters) in payment-stream contract
- ✅ Per-stream reentrancy locks using temporary storage
- ✅ Global reentrancy guard for admin operations
- ✅ Stream status tracking (Active, Paused, Canceled, Completed, Disputed)
- ✅ Campaign status tracking with historical entries

**What's Missing:**
- ❌ **No operation nonce concept** - workflows spanning multiple contracts lack a stable operation reference
- ❌ **No cross-contract operation correlation** - when campaign funding triggers payment stream creation, there's no way to trace the operation lineage
- ❌ **No recovery state machine** - if a multi-step workflow fails mid-execution, there's no way to determine what state should be recovered to
- ❌ **No operation sequence numbers** - can't verify operation ordering or detect gaps
- ❌ **No embedded operation ID in events** - events don't reference a master operation identifier

### Files Affected

**Contracts:**
- `/workspaces/stellar_client_os/contracts/payment-stream/src/lib.rs` (lines 605-900, stream creation & operations)
- `/workspaces/stellar_client_os/contracts/campaign-funding/src/lib.rs` (lines 750+, campaign operations)
- `/workspaces/stellar_client_os/contracts/distributor/src/lib.rs` (distribution operations)

**SDK:**
- `/workspaces/stellar_client_os/packages/sdk/src/PaymentStreamClient.ts` (stream operation clients)
- `/workspaces/stellar_client_os/packages/sdk/src/CampaignFundingClient.ts` (campaign operation clients)

### Specific Gaps

1. **No Operation Nonce Storage**
   ```rust
   // MISSING: Should exist in payment-stream DataKey enum
   // OperationNonce(stream_id) -> u64
   // This would store a nonce for each logical workflow step
   ```
   **Location:** `/workspaces/stellar_client_os/contracts/payment-stream/src/lib.rs` lines 13-35 (DataKey enum)

2. **Missing Cross-Contract Operation Correlation**
   ```rust
   // MISSING: When campaign-funding calls payment-stream create_batch_streams
   // should pass an operation_nonce parameter and embed it in returned events
   ```
   **Location:** `/workspaces/stellar_client_os/contracts/campaign-funding/src/lib.rs` (StreamContract field exists at line 178, but not used for operation tracking)

3. **Event Structures Lack Operation ID**
   ```rust
   // CURRENT: FeeCollectedEvent only contains stream_id and amount
   pub struct FeeCollectedEvent {
       pub stream_id: u64,
       pub amount: i128,
   }
   
   // MISSING: Should include operation_nonce for traceability
   pub struct FeeCollectedEvent {
       pub stream_id: u64,
       pub amount: i128,
       pub operation_nonce: u64,  // New field
   }
   ```
   **Location:** `/workspaces/stellar_client_os/contracts/payment-stream/src/lib.rs` lines 170-176 (FeeCollectedEvent), lines 178-183 (StreamDepositEvent), etc.

4. **No Recovery State Enumeration**
   ```rust
   // MISSING: Should be defined in each contract
   enum RecoveryState {
       // Stream creation recovery
       PreTransfer,      // Before token transfer
       PostTransfer,     // After token transfer, before state commit
       PostCommit,       // After state commit
       // Dispute resolution recovery
       PreTimelock,      // Before timelock window starts
       InTimelock,       // During timelock
       PostTimelock,     // After timelock, before execution
   }
   ```

5. **No Nonce Validation in Batch Operations**
   - `create_batch_streams` (line 693) creates multiple streams but has no way to detect if one succeeded and others failed
   - No checkpoint mechanism to determine which streams in a batch were successfully created
   - If token transfer fails mid-batch, there's no atomic rollback reference

### Suggested Approach

1. **Add Operation Nonce to DataKey Enum**
   ```rust
   enum DataKey {
       // ... existing variants ...
       OperationNonce(u64),           // Master nonce counter (instance storage)
       StreamOperationNonce(u64),     // Per-stream nonce (persistent storage)
   }
   ```

2. **Create Operation Correlation Event**
   ```rust
   #[contractevent(topics = ["OperationStarted"])]
   pub struct OperationStartedEvent {
       pub operation_nonce: u64,
       pub operation_type: Symbol,  // "stream_create", "batch_streams", etc.
       pub timestamp: u64,
       pub initiator: Address,
   }

   #[contractevent(topics = ["OperationCompleted"])]
   pub struct OperationCompletedEvent {
       pub operation_nonce: u64,
       pub status: Symbol,  // "success" or "partial"
       pub timestamp: u64,
   }
   ```

3. **Enhance Event Structures with Nonce**
   - Update all financial event structs to include `operation_nonce: u64`
   - This requires updating contracts, SDK types, and event decoders

4. **Implement Nonce Bump Pattern**
   ```rust
   fn get_next_operation_nonce(env: &Env) -> u64 {
       let mut nonce: u64 = env.storage().instance()
           .get(&DataKey::OperationNonce)
           .unwrap_or(0);
       if nonce == u64::MAX {
           panic_with_error!(env, Error::OperationNonceExhausted);
       }
       nonce += 1;
       env.storage().instance().set(&DataKey::OperationNonce, &nonce);
       nonce
   }
   ```

5. **Add Recovery State Checkpoints**
   ```rust
   enum DataKey {
       RecoveryCheckpoint(stream_id) -> (nonce, state)
   }
   ```

---

## Objective 2: Preserve Decimals and Asset Identity Assumptions on Liability Creation

### Current State

**What's Implemented:**
- ✅ i128 amounts throughout (enough range for any token)
- ✅ Checked arithmetic to prevent overflow (campaign-funding has comprehensive overflow audit)
- ✅ `exact-decimal.ts` utility for parsing human-readable amounts
- ✅ Protocol fee calculation with basis points
- ✅ Token contract address stored with stream
- ✅ Per-campaign token address enforcement

**What's Missing:**
- ❌ **No token decimals capture** - contracts don't store or validate token decimals
- ❌ **No asset identity proof** - no way to verify token contract hasn't changed mid-operation
- ❌ **No decimal validation on liability creation** - when stream is created, no check that token actually exists or has valid decimals
- ❌ **No decimal normalization in events** - events don't include decimals, making off-chain reconciliation ambiguous
- ❌ **No cross-token balance verification** - when multiple tokens involved, no systematic validation
- ❌ **Missing token info caching** - contracts re-query token metadata on every operation instead of caching

### Files Affected

**Contracts:**
- `/workspaces/stellar_client_os/contracts/payment-stream/src/lib.rs` (lines 605-900, stream creation)
- `/workspaces/stellar_client_os/contracts/campaign-funding/src/lib.rs` (entire contribution flow)
- `/workspaces/stellar_client_os/contracts/distributor/src/lib.rs` (distribute_equal, distribute_weighted)

**SDK:**
- `/workspaces/stellar_client_os/packages/sdk/src/utils/exact-decimal.ts` (decimal parsing - lines 1-50)
- `/workspaces/stellar_client_os/packages/sdk/src/CampaignFundingClient.ts` (campaign creation - lines 150-200)
- `/workspaces/stellar_client_os/packages/sdk/src/PaymentStreamClient.ts` (stream creation - lines 56-100)

### Specific Gaps

1. **No Token Decimals Storage or Validation**
   ```rust
   // MISSING: Stream struct should include decimals
   pub struct Stream {
       pub id: u64,
       pub sender: Address,
       pub recipient: Address,
       pub token: Address,
       // MISSING: pub token_decimals: u32,
       pub total_amount: i128,
       // ... rest of fields ...
   }
   ```
   **Location:** `/workspaces/stellar_client_os/contracts/payment-stream/src/lib.rs` lines 35-65

2. **Campaign Doesn't Store Token Metadata**
   ```rust
   // CURRENT: Campaign struct
   pub struct Campaign {
       pub id: u64,
       pub creator: Address,
       pub token: Address,
       pub target_amount: i128,
       // MISSING: pub token_decimals: u32,
       // ... rest of fields ...
   }
   ```
   **Location:** `/workspaces/stellar_client_os/contracts/campaign-funding/src/lib.rs` lines 210-250

3. **Event Structures Missing Decimal Info**
   ```rust
   // CURRENT: Events don't include decimals
   pub struct ContributionMadeEvent {
       pub campaign_id: u64,
       pub contributor: Address,
       pub amount: i128,
       pub total_raised: i128,
       // MISSING: pub token_decimals: u32,
   }
   ```
   **Location:** `/workspaces/stellar_client_os/contracts/campaign-funding/src/lib.rs` lines 365-375

4. **No Token Contract Integrity Check**
   ```rust
   // MISSING: Should validate token contract hasn't changed
   fn verify_token_identity(env: &Env, token: &Address, expected_decimals: u32) -> bool {
       // Not implemented - contracts assume token address is stable
   }
   ```

5. **Distributor Doesn't Validate Token Existence**
   ```rust
   // CURRENT: In distributor, no check that token is valid
   pub fn distribute_equal(
       env: Env,
       sender: Address,
       token: Address,
       total_amount: i128,
       recipients: Vec<Address>,
   ) {
       // token is used immediately without validation
       let token_client = token::Client::new(&env, &token);
       // If token address is invalid, error occurs mid-operation
   }
   ```
   **Location:** `/workspaces/stellar_client_os/contracts/distributor/src/lib.rs` lines 50-100

6. **SDK Has No Decimal Validation on Create**
   ```typescript
   // CURRENT: streamSponsorRewards doesn't validate or store decimals
   public async streamSponsorRewards(params: {
       campaign_id: bigint;
       contributor: AddressParam;
   }): Promise<AssembledTransaction<bigint>> {
       // No validation that campaign token decimals are known
       return executeWithErrorHandling(...)
   }
   ```
   **Location:** `/workspaces/stellar_client_os/packages/sdk/src/CampaignFundingClient.ts` lines 311-330

### Suggested Approach

1. **Add Token Decimals to DataKey Storage**
   ```rust
   enum DataKey {
       // ... existing variants ...
       TokenDecimals(Address) -> u32,  // Cache token decimals by address
       StreamTokenInfo(u64) -> (Address, u32),  // Token + decimals snapshot
   }
   ```

2. **Create Token Info Struct**
   ```rust
   #[contracttype]
   #[derive(Clone)]
   pub struct TokenInfo {
       pub address: Address,
       pub decimals: u32,
       pub captured_at: u64,  // Ledger when decimals were verified
   }
   ```

3. **Validate Token on Stream Creation**
   ```rust
   fn verify_and_cache_token(env: &Env, token_addr: &Address) -> Result<TokenInfo, Error> {
       // Check cache first
       let cached = env.storage().persistent()
           .get(&DataKey::TokenDecimals(token_addr.clone()));
       if let Some(decimals) = cached {
           return Ok(TokenInfo {
               address: token_addr.clone(),
               decimals,
               captured_at: env.ledger().timestamp(),
           });
       }
       
       // Query token contract for decimals
       let token_client = token::Client::new(&env, &token_addr);
       let decimals = token_client.decimals();  // May fail if token invalid
       
       // Cache the result
       env.storage().persistent().set(&DataKey::TokenDecimals(token_addr.clone()), &decimals);
       Ok(TokenInfo {
           address: token_addr.clone(),
           decimals,
           captured_at: env.ledger().timestamp(),
       })
   }
   ```

4. **Embed Token Info in Stream Creation Event**
   ```rust
   #[contractevent(topics = ["StreamCreated"])]
   pub struct StreamCreatedEvent {
       pub stream_id: u64,
       pub sender: Address,
       pub recipient: Address,
       pub token: Address,
       pub token_decimals: u32,  // NEW
       pub total_amount: i128,
       pub start_time: u64,
       pub end_time: u64,
   }
   ```

5. **Update All Financial Events to Include Decimals**
   - `ContributionMadeEvent` (campaign-funding)
   - `FeeCollectedEvent` (payment-stream)
   - `StreamDepositEvent` (payment-stream)
   - All distributor events

6. **Add Token Validation to Distributor**
   ```rust
   fn validate_recipients_and_token(
       env: &Env,
       token: &Address,
       recipients: &Vec<Address>,
   ) -> Result<TokenInfo, Error> {
       // Verify token exists and has valid decimals
       let token_info = verify_and_cache_token(env, token)?;
       
       // Verify no duplicate recipients
       for i in 0..recipients.len() {
           for j in (i+1)..recipients.len() {
               if recipients.get(i).unwrap() == recipients.get(j).unwrap() {
                   return Err(Error::DuplicateRecipient);
               }
           }
       }
       Ok(token_info)
   }
   ```

7. **Update SDK to Store and Validate Decimals**
   ```typescript
   // In PaymentStreamClient
   private tokenDecimals: Map<string, number> = new Map();
   
   async getTokenDecimals(tokenAddress: string): Promise<number> {
       if (this.tokenDecimals.has(tokenAddress)) {
           return this.tokenDecimals.get(tokenAddress)!;
       }
       // Query or cache from contract/ledger
       const decimals = await this.fetchTokenDecimals(tokenAddress);
       this.tokenDecimals.set(tokenAddress, decimals);
       return decimals;
   }
   ```

---

## Objective 3: Bound Recipients, Purposes, Limits, and Authorization for Protocol-Owned Funds

### Current State

**What's Implemented:**
- ✅ `FeeCollector` address stored in instance storage
- ✅ `Admin` address with authorization checks
- ✅ Per-stream recipient validation (must be legitimate Address)
- ✅ Protocol fee calculation and collection
- ✅ Fee tier system for volume-based discounts (payment-stream)
- ✅ Insurance pool concept (campaign-funding, but not fully isolated)

**What's Missing:**
- ❌ **No "protocol fund" concept** - fees are collected but have no explicit purpose boundaries
- ❌ **No authorization scope limits** - admin can set fee collector to any address without purpose validation
- ❌ **No fund purpose tracking** - can't distinguish between protocol fees, reserves, insurance pools
- ❌ **No spending limits per purpose** - no caps on how much can be withdrawn from fee collector
- ❌ **No multi-recipient authorization** - protocol funds can only go to a single address (fee_collector)
- ❌ **No fund segregation in events** - can't trace which pool a fee belongs to (protocol vs insurance vs reserve)
- ❌ **Insurance pool is underfunded concept** - campaign-funding stores `InsurancePool` by token, but no lifecycle or governance

### Files Affected

**Contracts:**
- `/workspaces/stellar_client_os/contracts/payment-stream/src/lib.rs` (lines 360-400, fee collector setup; lines 1430-1470, fee collection)
- `/workspaces/stellar_client_os/contracts/campaign-funding/src/lib.rs` (lines 765-780, insurance pool; lines 800+, reserve calculation)
- `/workspaces/stellar_client_os/contracts/distributor/src/lib.rs` (no protocol fund concept currently)

**SDK:**
- `/workspaces/stellar_client_os/packages/sdk/src/PaymentStreamClient.ts` (initialize methods)

### Specific Gaps

1. **No Fund Purpose Enumeration**
   ```rust
   // MISSING: Should be defined in payment-stream
   enum FundPurpose {
       ProtocolFees,
       Insurance,
       Reserve,
       Matching,  // For campaign matching funds
       Treasury,  // Protocol treasury
   }
   ```

2. **Fee Collector Can Be Any Address**
   ```rust
   // CURRENT: initialize() at lines 360-400
   pub fn initialize(env: Env, admin: Address, fee_collector: Address, general_fee_rate: u32) {
       // fee_collector can be any address - no validation that it's a legitimate protocol address
       admin.require_auth();
       env.storage().instance().set(&DataKey::FeeCollector, &fee_collector);
       // No purpose binding, no spending limits
   }
   ```
   **Location:** `/workspaces/stellar_client_os/contracts/payment-stream/src/lib.rs` lines 360-400

3. **No Fund Spending Authorization Framework**
   ```rust
   // MISSING: No way to authorize fund withdrawals by purpose
   struct FundWithdrawalAuthorization {
       purpose: FundPurpose,
       authorized_recipient: Address,
       max_amount: i128,
       expiry: u64,
   }
   ```

4. **Insurance Pool Not Segregated**
   ```rust
   // CURRENT: Campaign-funding stores insurance in generic pool
   enum DataKey {
       InsurancePool(Address),  // Only one pool per token, no governance
       // MISSING: Should support multiple pools with different purposes
   }
   ```
   **Location:** `/workspaces/stellar_client_os/contracts/campaign-funding/src/lib.rs` lines 165-180

5. **Reserve Pool Calculation Not Explicit**
   ```rust
   // CURRENT: Reserve is calculated but stored in generic key
   DataKey::Reserve(u64)  // Reserve for a campaign, not a protocol-wide fund
   // MISSING: Distinction between campaign reserve and protocol reserve
   ```

6. **Fee Collection Events Don't Specify Purpose**
   ```rust
   pub struct FeeCollectedEvent {
       pub stream_id: u64,
       pub amount: i128,
       // MISSING: pub purpose: FundPurpose,
   }
   ```
   **Location:** `/workspaces/stellar_client_os/contracts/payment-stream/src/lib.rs` lines 170-176

### Suggested Approach

1. **Create Fund Purpose and Authorization Structs**
   ```rust
   #[contracttype]
   #[derive(Clone, Copy, Debug, Eq, PartialEq)]
   pub enum FundPurpose {
       ProtocolFees = 0,
       Insurance = 1,
       Reserve = 2,
       Matching = 3,
       Treasury = 4,
   }

   #[contracttype]
   #[derive(Clone)]
   pub struct FundRecipientAuth {
       pub purpose: FundPurpose,
       pub recipient: Address,
       pub authorized_by: Address,
       pub authorized_at: u64,
       pub max_amount_per_tx: i128,  // 0 = unlimited
       pub total_cap: i128,            // 0 = unlimited
       pub expiry: u64,                // 0 = no expiry
   }

   #[contracttype]
   #[derive(Clone)]
   pub struct FundWithdrawalRecord {
       pub purpose: FundPurpose,
       pub recipient: Address,
       pub amount: i128,
       pub withdrawn_at: u64,
       pub tx_hash: BytesN<32>,  // Transaction reference
   }
   ```

2. **Add Fund Authorization to DataKey**
   ```rust
   enum DataKey {
       // ... existing ...
       FundPurposeAuth(purpose) -> Address,     // Primary authorized recipient per purpose
       FundRecipientAuth((purpose, recipient)) -> FundRecipientAuth,  // Detailed auth
       FundBalance(purpose) -> i128,             // Running balance per purpose
       FundWithdrawalHistory(seq_num) -> FundWithdrawalRecord,
   }
   ```

3. **Create Separate Fee Collection Events**
   ```rust
   #[contractevent(topics = ["FeeCollected"])]
   pub struct FeeCollectedEvent {
       pub stream_id: u64,
       pub amount: i128,
       pub purpose: FundPurpose,  // NEW
       pub from_recipient: Address,  // Who paid the fee
   }

   #[contractevent(topics = ["InsuranceAccrued"])]
   pub struct InsuranceAccruedEvent {
       pub campaign_id: u64,
       pub amount: i128,
       pub pool_total: i128,
   }

   #[contractevent(topics = ["ReserveAccrued"])]
   pub struct ReserveAccruedEvent {
       pub campaign_id: u64,
       pub amount: i128,
       pub for_purpose: FundPurpose,
   }
   ```

4. **Implement Fund Authorization Control**
   ```rust
   fn set_fund_recipient_auth(
       env: &Env,
       purpose: FundPurpose,
       recipient: Address,
       max_amount_per_tx: i128,
       total_cap: i128,
       expiry: u64,
   ) {
       let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
       admin.require_auth();

       let auth = FundRecipientAuth {
           purpose,
           recipient: recipient.clone(),
           authorized_by: admin,
           authorized_at: env.ledger().timestamp(),
           max_amount_per_tx,
           total_cap,
           expiry,
       };
       env.storage().instance().set(
           &DataKey::FundRecipientAuth((purpose, recipient.clone())),
           &auth,
       );
   }

   fn withdraw_funds(
       env: &Env,
       purpose: FundPurpose,
       amount: i128,
   ) -> i128 {
       let withdrawer: Address = env.storage().instance()
           .get(&DataKey::FundPurposeAuth(purpose))
           .expect("No authorized recipient for this purpose");
       withdrawer.require_auth();

       let auth = env.storage().instance()
           .get(&DataKey::FundRecipientAuth((purpose, withdrawer.clone())))
           .expect("Auth record missing");

       if env.ledger().timestamp() > auth.expiry && auth.expiry != 0 {
           panic_with_error!(env, Error::AuthExpired);
       }
       if auth.max_amount_per_tx > 0 && amount > auth.max_amount_per_tx {
           panic_with_error!(env, Error::WithdrawalExceedsLimit);
       }

       // Check balance
       let available: i128 = env.storage().instance()
           .get(&DataKey::FundBalance(purpose))
           .unwrap_or(0);
       if amount > available {
           panic_with_error!(env, Error::InsufficientFunds);
       }

       // Record withdrawal
       let record = FundWithdrawalRecord {
           purpose,
           recipient: withdrawer.clone(),
           amount,
           withdrawn_at: env.ledger().timestamp(),
           tx_hash: env.current_contract_address().clone().to_xdr(&env).slice(0..32).unwrap_or_default(),
       };
       // Store record with sequence number
       let mut seq: u64 = env.storage().instance()
           .get(&Symbol::new(&env, "fund_wd_seq"))
           .unwrap_or(0);
       env.storage().instance().set(&DataKey::FundWithdrawalHistory(seq), &record);
       seq += 1;
       env.storage().instance().set(&Symbol::new(&env, "fund_wd_seq"), &seq);

       // Update balance
       let new_balance = available - amount;
       env.storage().instance().set(&DataKey::FundBalance(purpose), &new_balance);

       FundWithdrawnEvent { purpose, amount, to: withdrawer }.publish(&env);
       amount
   }
   ```

5. **Segregate Insurance and Reserve Pools**
   ```rust
   // In campaign-funding, change to:
   enum DataKey {
       // ... existing ...
       ReservePerCampaign(u64) -> i128,  // Per-campaign reserve
       InsurancePoolPerToken((Address, FundPurpose)) -> i128,  // Insurance pool segregated by purpose
   }
   ```

6. **Update SDK to Track Fund Authorizations**
   ```typescript
   // In PaymentStreamClient
   async setFundRecipientAuth(params: {
       purpose: string;
       recipient: AddressParam;
       max_amount_per_tx: bigint;
       total_cap: bigint;
       expiry: bigint;
   }): Promise<AssembledTransaction<null>> {
       return executeWithErrorHandling(...)
   }

   async withdrawFunds(params: {
       purpose: string;
       amount: bigint;
   }): Promise<AssembledTransaction<bigint>> {
       return executeWithErrorHandling(...)
   }
   ```

---

## Objective 4: Make Every Liability Change Traceable to a Stable Operation and Event Reference

### Current State

**What's Implemented:**
- ✅ Contract events emitted for major state changes (FeeCollected, StreamDeposit, ContributionMade)
- ✅ Stream metrics tracking (withdrawal_count, pause_count, etc.)
- ✅ Campaign status history with timestamps
- ✅ Event decoder utilities in SDK (`event-decoders.ts`, `event-validator.ts`)
- ✅ Audit logging framework (audit.ts) for privileged actions
- ✅ BalanceWatcher for monitoring balance changes
- ✅ Stream history utils (`streamHistory.ts`)

**What's Missing:**
- ❌ **No transaction hash in events** - can't trace back to on-chain transaction
- ❌ **No master ledger sequence** - events don't include the ledger sequence they occurred in
- ❌ **No causality chain** - can't link a withdrawal event back to the deposit that funded it
- ❌ **No liability snapshot in events** - don't capture total liability before/after each change
- ❌ **No reconciliation audit trail** - no structured way to verify all liability changes sum correctly
- ❌ **No withdrawal destination metadata** - withdrawal events don't record where funds went
- ❌ **No custody chain tracking** - can't verify fund movement across addresses
- ❌ **Missing deterministic ordering** - events at same timestamp can't be ordered

### Files Affected

**Contracts:**
- `/workspaces/stellar_client_os/contracts/payment-stream/src/lib.rs` (all event publishing)
- `/workspaces/stellar_client_os/contracts/campaign-funding/src/lib.rs` (all event publishing)
- `/workspaces/stellar_client_os/contracts/distributor/src/lib.rs` (distribution events)

**SDK:**
- `/workspaces/stellar_client_os/packages/sdk/src/utils/event-decoders.ts` (event parsing)
- `/workspaces/stellar_client_os/packages/sdk/src/utils/event-validator.ts` (event validation)
- `/workspaces/stellar_client_os/packages/sdk/src/utils/BalanceWatcher.ts` (balance tracking)
- `/workspaces/stellar_client_os/packages/sdk/src/utils/streamHistory.ts` (stream history)

### Specific Gaps

1. **Events Missing Ledger Context**
   ```rust
   // CURRENT: Events have minimal metadata
   pub struct FeeCollectedEvent {
       pub stream_id: u64,
       pub amount: i128,
       // MISSING:
       // pub ledger_sequence: u32,
       // pub tx_hash: BytesN<32>,
       // pub operation_index: u32,
   }
   ```
   **Location:** `/workspaces/stellar_client_os/contracts/payment-stream/src/lib.rs` lines 170-176

2. **No Liability Snapshot in Withdrawal Events**
   ```rust
   // MISSING: Should capture stream state before and after withdrawal
   pub struct StreamWithdrawnEvent {
       pub stream_id: u64,
       pub withdrawn_by: Address,
       pub amount: i128,
       pub recipient: Address,
       // MISSING:
       // pub balance_before: i128,
       // pub balance_after: i128,
       // pub total_withdrawn_cumulative: i128,
       // pub withdrawable_remaining: i128,
   }
   ```

3. **No Causality Link Between Deposits and Withdrawals**
   ```rust
   // MISSING: No way to correlate which deposit funded which withdrawal
   pub struct StreamDepositEvent {
       pub stream_id: u64,
       pub amount: i128,
       // MISSING:
       // pub deposit_id: u64,  // Sequential deposit counter
       // pub funding_source: Address,
       // pub balance_before: i128,
   }

   pub struct StreamWithdrawnEvent {
       pub stream_id: u64,
       pub amount: i128,
       // MISSING:
       // pub funded_by_deposits: Vec<u64>,  // Which deposits funded this
   }
   ```

4. **Campaign Contribution Events Missing State**
   ```rust
   pub struct ContributionMadeEvent {
       pub campaign_id: u64,
       pub contributor: Address,
       pub amount: i128,
       pub total_raised: i128,
       // MISSING:
       // pub contribution_id: u64,
       // pub escrow_balance_before: i128,
       // pub timestamp: u64,
       // pub milestone_reached: Option<u32>,  // % milestone
   }
   ```
   **Location:** `/workspaces/stellar_client_os/contracts/campaign-funding/src/lib.rs` lines 365-375

5. **Distributor Events Don't Track Individual Transfers**
   ```rust
   // MISSING: Distributor should emit per-recipient events
   pub struct DistributionEvent {
       pub distribution_id: u64,
       pub token: Address,
       pub sender: Address,
       pub recipient: Address,
       pub amount: i128,
       pub fee_collected: i128,
   }
   ```

6. **No Reconciliation Metadata in Events**
   ```rust
   // MISSING: Events should support independent audit
   pub struct ReconciliationMetadata {
       pub ledger_sequence: u32,
       pub created_at: u64,
       pub operation_nonce: u64,
       pub hash_chain: BytesN<32>,  // Hash of previous event for chain
       pub total_liability_after: i128,
   }
   ```

7. **SDK Event Decoder Missing Reconciliation Logic**
   ```typescript
   // CURRENT: event-decoders.ts can't verify:
   // - All events for a stream account for balance
   // - No amount gaps
   // - Proper ordering
   
   // MISSING: Reconciliation verifier
   interface ReconciliationResult {
       isValid: boolean;
       totalDebits: bigint;
       totalCredits: bigint;
       gaps: string[];
       warnings: string[];
   }
   ```
   **Location:** `/workspaces/stellar_client_os/packages/sdk/src/utils/event-decoders.ts`

### Suggested Approach

1. **Create Comprehensive Event Metadata Structure**
   ```rust
   #[contracttype]
   #[derive(Clone)]
   pub struct EventMetadata {
       pub ledger_sequence: u32,
       pub timestamp: u64,
       pub operation_nonce: u64,
       pub event_sequence_within_tx: u32,
       pub previous_event_hash: BytesN<32>,  // For chaining
   }
   ```

2. **Enhance All Liability Change Events**
   ```rust
   #[contractevent(topics = ["StreamDeposited"])]
   pub struct StreamDepositedEvent {
       pub stream_id: u64,
       pub deposit_id: u64,  // NEW: Sequential deposit counter
       pub amount: i128,
       pub from: Address,
       pub balance_before: i128,  // NEW
       pub balance_after: i128,   // NEW
       pub ledger_sequence: u32,  // NEW
       pub tx_hash: BytesN<32>,   // NEW
   }

   #[contractevent(topics = ["StreamWithdrawn"])]
   pub struct StreamWithdrawnEvent {
       pub stream_id: u64,
       pub withdrawal_id: u64,    // NEW: Sequential withdrawal counter
       pub amount: i128,
       pub recipient: Address,
       pub balance_before: i128,  // NEW
       pub balance_after: i128,   // NEW
       pub net_after_fees: i128,  // NEW
       pub ledger_sequence: u32,  // NEW
       pub tx_hash: BytesN<32>,   // NEW
   }
   ```

3. **Add Sequencing Counters to DataKey**
   ```rust
   enum DataKey {
       // ... existing ...
       StreamDepositCount(u64) -> u64,       // Sequential deposits per stream
       StreamWithdrawalCount(u64) -> u64,    // Sequential withdrawals per stream
       CampaignContributionCount(u64) -> u64,  // Sequential contributions per campaign
       ContributionId((u64, u64)) -> Address,  // contribution_id -> contributor
   }
   ```

4. **Implement Event Hash Chain for Audit**
   ```rust
   fn compute_event_hash(env: &Env, event_data: &[u8], previous_hash: &BytesN<32>) -> BytesN<32> {
       use soroban_sdk::Bytes;
       let mut combined = Bytes::new(env);
       combined.append(&Bytes::copy_from_slice(env, previous_hash.as_slice()));
       combined.append(&Bytes::copy_from_slice(env, event_data));
       // Use env's built-in crypto if available, or simple hash
       env.crypto().keccak256(&combined)
   }

   fn get_last_event_hash(env: &Env, stream_id: u64) -> BytesN<32> {
       env.storage().persistent()
           .get(&DataKey::LastEventHash(stream_id))
           .unwrap_or_else(|| BytesN::zero(env))
   }

   fn record_event_hash(env: &Env, stream_id: u64, hash: BytesN<32>) {
       env.storage().persistent().set(&DataKey::LastEventHash(stream_id), &hash);
   }
   ```

5. **Create Liability Summary Checkpoint**
   ```rust
   #[contractevent(topics = ["LiabilityCheckpoint"])]
   pub struct LiabilityCheckpointEvent {
       pub stream_id: u64,
       pub checkpoint_timestamp: u64,
       pub total_escrowed: i128,
       pub total_withdrawn: i128,
       pub total_fees_collected: i128,
       pub pending_disputes: u32,
       pub ledger_sequence: u32,
   }

   fn emit_checkpoint(env: &Env, stream_id: u64) {
       let stream = Self::get_stream(env.clone(), stream_id);
       let metrics = Self::get_stream_metrics(env.clone(), stream_id);
       
       LiabilityCheckpointEvent {
           stream_id,
           checkpoint_timestamp: env.ledger().timestamp(),
           total_escrowed: stream.balance + stream.withdrawn_amount,
           total_withdrawn: stream.withdrawn_amount,
           total_fees_collected: metrics.fees_paid,
           pending_disputes: 0,  // Or look up from disputes storage
           ledger_sequence: env.ledger().sequence(),
       }.publish(&env);
   }
   ```

6. **Enhance SDK Event Decoder with Reconciliation**
   ```typescript
   // In event-decoders.ts
   export interface LiabilityAuditTrail {
       streamId: bigint;
       startingBalance: bigint;
       endingBalance: bigint;
       totalDebits: bigint;  // Withdrawals
       totalCredits: bigint; // Deposits
       totalFees: bigint;
       eventCount: number;
       isBalanced: boolean;
       violations: string[];
   }

   export function reconcileStreamLiability(
       events: PaymentStreamDecodedEvent[]
   ): LiabilityAuditTrail {
       const streamId = /* extract from first event */;
       let balance = 0n;
       let totalDebits = 0n;
       let totalCredits = 0n;
       let totalFees = 0n;

       for (const event of events) {
           switch (event.type) {
               case 'StreamDeposit':
                   balance += event.payload.amount;
                   totalCredits += event.payload.amount;
                   break;
               case 'StreamWithdrawn':
                   balance -= event.payload.net_amount;
                   totalDebits += event.payload.net_amount;
                   break;
               case 'FeeCollected':
                   totalFees += event.payload.amount;
                   break;
           }
       }

       return {
           streamId,
           startingBalance: 0n,  // Would need first checkpoint
           endingBalance: balance,
           totalDebits,
           totalCredits,
           totalFees,
           eventCount: events.length,
           isBalanced: totalCredits === (totalDebits + totalFees),
           violations: totalCredits !== (totalDebits + totalFees) 
               ? ['Balance mismatch: credits != debits + fees']
               : [],
       };
   }
   ```

7. **Create Independent Audit Event**
   ```rust
   #[contractevent(topics = ["AuditCompleted"])]
   pub struct AuditCompletedEvent {
       pub auditor: Address,
       pub audit_type: Symbol,  // "stream_reconciliation", "campaign_funds", etc.
       pub period_start: u64,
       pub period_end: u64,
       pub events_audited: u32,
       pub discrepancies: u32,
       pub audit_hash: BytesN<32>,  // Hash of audit findings
   }
   ```

---

## Cross-Cutting Concerns

### 1. Event Versioning Strategy
All events need versioning to support future schema evolution:
```rust
#[contractevent(topics = ["StreamWithdrawn"])]
pub struct StreamWithdrawnEvent {
    pub event_version: u8,  // Version 1, 2, 3, etc.
    pub stream_id: u64,
    // ... fields ...
}
```

### 2. SDK Integration Checklist
- ✅ Update generated contract types to include new event fields
- ✅ Update event decoders to handle optional/new fields
- ✅ Add event validator to check consistency
- ✅ Add reconciliation engine
- ✅ Update test suite for all new events

### 3. Backwards Compatibility
- All new event fields should be optional/have defaults
- Old contract versions should continue working
- SDK should handle both old and new event schemas

### 4. Performance Implications
- Adding fields to events increases XDR size slightly
- Hash chain computation adds ~1ms per event
- Ledger sequence storage is small (u32)
- Consider batching checkpoint events (not on every operation)

---

## Implementation Priority Matrix

| Objective | Complexity | Impact | Priority | Est. Effort |
|-----------|-----------|--------|----------|------------|
| 1. Operation Nonces | Medium | High | **1** | 3-4 weeks |
| 2. Decimals & Asset Identity | Low | High | **2** | 2-3 weeks |
| 3. Fund Authorization Boundaries | Medium | Medium | **3** | 2-3 weeks |
| 4. Liability Traceability | Medium | Very High | **1** | 3-4 weeks |

**Recommended Sequence:**
1. Start with Objectives 1 & 4 in parallel (operation infrastructure)
2. Implement Objective 2 (decimals - low risk, high value)
3. Then Objective 3 (fund governance)

---

## Testing Strategy

### For Each Objective:

**Objective 1 - Operation Nonces:**
- ✅ Test nonce increment on each operation
- ✅ Test nonce in events
- ✅ Test nonce exhaustion (u64::MAX)
- ✅ Test cross-contract nonce correlation
- ✅ Test recovery state checkpoints

**Objective 2 - Decimals:**
- ✅ Test decimal caching per token
- ✅ Test decimal validation on stream creation
- ✅ Test events include decimals
- ✅ Test off-chain decimal parsing correctness
- ✅ Test multi-token campaign scenarios

**Objective 3 - Fund Authorization:**
- ✅ Test fund authorization setup
- ✅ Test authorization expiry
- ✅ Test withdrawal limits
- ✅ Test unauthorized withdrawal rejection
- ✅ Test fund purpose tracking in events

**Objective 4 - Traceability:**
- ✅ Test all events include metadata (ledger, tx_hash, nonce)
- ✅ Test event hash chain construction
- ✅ Test liability reconciliation engine
- ✅ Test event ordering by timestamp + sequence
- ✅ Test checkpoint consistency

---

## Appendix: File Reference Summary

### Contract Files Requiring Changes
1. `/workspaces/stellar_client_os/contracts/payment-stream/src/lib.rs` - All 4 objectives
2. `/workspaces/stellar_client_os/contracts/campaign-funding/src/lib.rs` - Objectives 1, 2, 3
3. `/workspaces/stellar_client_os/contracts/distributor/src/lib.rs` - Objectives 2, 4

### SDK Files Requiring Changes
1. `/workspaces/stellar_client_os/packages/sdk/src/PaymentStreamClient.ts` - All 4 objectives
2. `/workspaces/stellar_client_os/packages/sdk/src/CampaignFundingClient.ts` - Objectives 1, 2, 3
3. `/workspaces/stellar_client_os/packages/sdk/src/utils/event-decoders.ts` - Objectives 1, 4
4. `/workspaces/stellar_client_os/packages/sdk/src/utils/event-validator.ts` - Objectives 2, 4
5. `/workspaces/stellar_client_os/packages/sdk/src/utils/exact-decimal.ts` - Objective 2
6. `/workspaces/stellar_client_os/packages/sdk/src/utils/BalanceWatcher.ts` - Objective 4

### Documentation Files
1. Create new contract documentation for operation nonces
2. Create token decimals specification
3. Create fund governance specification
4. Create audit trail and reconciliation spec

---

## Conclusion

These four objectives form an integrated framework for reliable financial operations:

1. **Operation Nonces** enable deterministic recovery and ordering
2. **Decimal & Asset Identity** preservation prevents amount mismatch vulnerabilities
3. **Fund Authorization Boundaries** enable governance and compliance
4. **Liability Traceability** enables independent reconciliation and audit

Implementing all four creates a system where every token movement can be:
- ✅ Traced to a specific operation (nonce)
- ✅ Verified at the correct decimal precision
- ✅ Authorized by the right principal
- ✅ Independently audited and reconciled

---

**Document Version:** 1.0  
**Last Updated:** 2024-12-19  
**Author:** Kiro Analysis
