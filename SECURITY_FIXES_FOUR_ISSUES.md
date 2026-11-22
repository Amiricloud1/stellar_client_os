# Security Fixes: Four Critical Issues

This document describes the fixes applied to address four critical security and functionality objectives in the campaign-funding smart contract.

## Issue 1: Version-Bounded Fee Parameters

**Problem:** Protocol fee changes were applied retroactively to all campaigns. If an admin raised fees from 2.5% to 5%, existing campaigns would immediately be charged the new higher rate when claimed, violating the principle of preserving applicable terms.

**Solution:** Implement fee-parameter versioning:

```rust
// DataKey additions:
FeeVersion,                              // Global version counter
CampaignFeeVersion(u64),                 // Snapshot at campaign creation
CampaignFeeRateSnapshot(u64),            // Fee rate locked in for campaign
```

**Key Functions:**
- `initialize()` - seeds `FeeVersion = 1`
- `set_fee_rate()` - increments `FeeVersion` atomically when rate changes
- `create_campaign()` - snapshots current fee rate into `CampaignFeeRateSnapshot(campaign_id)`
- `claim_funds()` - uses the campaign's locked-in rate, not the global rate

**Invariants:**
- Each campaign has its own immutable fee rate from creation time
- Global fee changes only affect newly created campaigns
- `FeeVersion` increments monotonically on each rate change
- Existing campaigns are immune to retroactive fee increases

---

## Issue 2: Balance Conservation & Separate Fee Liability

**Problem:** Fee deductions and sponsor contributions were intermingled. There was no separation between:
- Sponsor-deposited funds (meant for creators/refunds)
- Protocol-fee liability (meant for fee collector)
- Insurance pool deposits

This made it impossible to prove balance conservation across deposits, payouts, and refunds.

**Solution:** Introduce separate ledger buckets:

```rust
// DataKey additions:
SponsorBalance(u64),        // Net sponsor funds (fee not yet deducted)
FeeLiability(u64),          // Accrued fee obligation
InsurancePool(Address),     // Insurance fund per token
```

**Key Invariant: Balance Conservation**
```
At all times after a contribution:
  SponsorBalance(campaign_id) == sum of all contribution amounts (pre-fee)
  total_raised == SponsorBalance + (implicit matching funds)
  
At claim time:
  claim_funds() asserts:
    sponsor_balance == campaign.total_raised
  Then transfers:
    - fee_liability → fee_collector
    - (sponsor_balance - fee_liability) → campaign_creator
```

**Functions Modified:**
- `contribute()` - updates BOTH `SponsorBalance` and `FeeLiability` buckets
- `claim_funds()` - asserts conservation before any transfer
- `claim_refund()` - reduces both buckets proportionally
- `deposit_to_campaign_escrow()` - mirrors contributions in both buckets

**Proof of Correctness:**
1. Every `contribute(amount)` increases `SponsorBalance` and accrues `FeeLiability`
2. `total_raised` = `SponsorBalance` (holds as invariant)
3. At claim: `sponsor_balance == total_raised` (asserted, panics if violated)
4. Refunds: debit sponsor balance and proportional fee liability
5. Final transfer = `sponsor_balance - fee_liability` leaves no orphaned funds

---

## Issue 3: Atomic Matching Fund & Double-Spend Prevention

**Problem:** Matching funds could be claimed multiple times by the same contributor, or matching could be double-spent in cross-campaign scenarios.

**Solution:** Implement idempotency and atomic debit:

```rust
// DataKey additions:
MatchingClaimUsed(u64, Address),        // Idempotency flag per (campaign, contributor)
MatchingCap(u64),                       // Admin-set matching cap
MatchingBalance(u64),                   // Remaining unspent matching
MatchingUsed(u64),                      // Consumed matching (audit trail)
```

**Key Functions:**

### `set_matching_fund(campaign_id, funder, cap, token)`
- Admin deposits `cap` tokens from `funder`
- Records `MatchingCap(campaign_id) = cap`
- Records `MatchingBalance(campaign_id) = cap` (unspent)

### `claim_matching(campaign_id, contributor, match_amount)`
1. **Check idempotency:** if `MatchingClaimUsed(campaign_id, contributor)` exists, panic
2. **Atomic debit:** `new_balance = MatchingBalance - match_amount` (panics on underflow)
3. **Mark used:** set `MatchingClaimUsed(campaign_id, contributor) = true`
4. **Effects before interactions:** state mutations BEFORE token transfer
5. **Apply contribution:** increment `total_raised` and `SponsorBalance`

**State Machine Invariants:**
- `MatchingBalance >= 0` always (checked subtraction panics)
- `MatchingUsed + MatchingBalance == MatchingCap` (budget conservation)
- `MatchingClaimUsed(campaign, contributor)` prevents replay
- Token transfer only succeeds if all state mutations are committed

**Recovery:** If token transfer fails after state update, the ledger is already consistent:
- Matching has been deducted (safe for next call)
- Balance is reduced (idempotency prevents double-claim)
- New attempt will panic (grant already used)

---

## Issue 4: Scoped, Revocable Delegate Constraints

**Problem:** No delegation system existed. Need per-campaign, per-token, per-amount constraints with explicit revocation and no unrestricted approvals.

**Solution:** Implement nonce-based scoped grants:

```rust
// DataKey additions:
Delegate(Address, u64, u64),            // (delegator, campaign_id, nonce) → DelegateGrant
DelegatorNonce(Address),                // Per-delegator monotonic counter

pub struct DelegateGrant {
    delegator: Address,
    delegate: Address,
    campaign_id: u64,
    token: Address,
    max_amount: i128,
    remaining_amount: i128,
    nonce: u64,
    expiry: u64,
}
```

**Key Functions:**

### `grant_delegate(delegator, delegate, campaign_id, token, max_amount, expiry) → nonce`
- Requires `delegator.require_auth()`
- Increments `DelegatorNonce(delegator)` atomically → `nonce`
- Creates unique grant indexed by `(delegator, campaign_id, nonce)`
- Grant is scoped to exactly ONE `campaign_id`, ONE `token`, ONE `max_amount`
- No catch-all "approve all" paths

### `revoke_delegate(delegator, campaign_id, nonce)`
- Requires `delegator.require_auth()`
- Locates grant by `(delegator, campaign_id, nonce)`
- Sets `grant.remaining_amount = 0` (permanently invalidates)
- Prevents any further spending under that nonce

### `contribute_as_delegate(delegate, delegator, campaign_id, nonce, amount)`
- Requires `delegate.require_auth()` (delegate must sign)
- Loads grant by `(delegator, campaign_id, nonce)`
- Validates:
  1. `now <= grant.expiry` (enforces time window)
  2. `campaign_id == grant.campaign_id` (enforces campaign scope)
  3. `campaign.token == grant.token` (enforces asset scope)
  4. `amount <= grant.remaining_amount` (enforces amount cap)
- **Atomic debit:** `grant.remaining_amount -= amount` (panics on underflow)
- Applies contribution on behalf of `delegator` using their tokens

**Constraint Matrix:**
```
                    Enforced    Revocable   Atomic
Campaign ID         ✓           ✓           ✓
Token/Asset         ✓           ✓           ✓
Max Amount          ✓           ✓           ✓
Nonce (uniqueness)  ✓           ✓           ✓
Expiry (time)       ✓           ✓           ✓
```

**No Unrestricted Paths:**
- Every grant requires explicit `campaign_id`
- Every grant requires explicit `token`
- Every grant requires explicit `max_amount`
- Every grant requires explicit `expiry`
- **No "approve all"**: must create separate grant per campaign

**Example Usage:**
```rust
// Delegator authorizes delegate to spend up to 1000 USDC on campaign #5
let nonce = grant_delegate(
    delegator,
    delegate,
    5,                    // only campaign 5
    usdc_token,           // only USDC
    1000,                 // max 1000 stroops
    timestamp + 30*24*3600 // expires in 30 days
);

// Delegate can then call:
contribute_as_delegate(delegate, delegator, 5, nonce, 500); // uses 500
contribute_as_delegate(delegate, delegator, 5, nonce, 400); // uses 400
// contribute_as_delegate(delegate, delegator, 5, nonce, 200); // PANIC: 200 > 100 remaining

// Delegator can revoke anytime:
revoke_delegate(delegator, 5, nonce); // sets remaining to 0
// Now: contribute_as_delegate(...) panics (insufficient)
```

---

## Cross-Issue Integrity

The four fixes are coordinated:

1. **Issue 1 + Issue 2:** Fee rate snapshots use the versioned rate from creation; `claim_funds()` uses `CampaignFeeRateSnapshot` to compute liability
2. **Issue 2 + Issue 3:** Matching funds update `SponsorBalance` and respect the conservation invariant
3. **Issue 3 + Issue 4:** Both use atomic state mutations with check-effects-interactions pattern
4. **Issue 4 + Issue 1:** Delegate spends are subject to campaign's fee rate at time of spend

---

## Testing

All issues are covered by comprehensive tests in the contract:

- **Issue 1:** `test_fee_version_increments_on_rate_change()`, `test_existing_campaign_keeps_original_fee_rate_after_global_change()`
- **Issue 2:** `test_sponsor_balance_and_fee_liability_track_separately()`, `test_refund_reduces_sponsor_balance_and_fee_liability()`
- **Issue 3:** `test_matching_claim_double_spend_rejected()`
- **Issue 4:** `test_grant_and_use_delegate_within_allowance()`, `test_delegate_over_allowance_rejected()`, `test_revoked_delegate_cannot_spend()`, `test_expired_delegate_rejected()`, `test_nonce_increments_per_delegator()`

---

## Summary

| Issue | Problem | Solution | Key Data Structures | Key Invariants |
|-------|---------|----------|-------------------|-----------------|
| 1 | Retroactive fee changes | Version-stamp parameters at creation | `FeeVersion`, `CampaignFeeRateSnapshot` | Each campaign immutable fee |
| 2 | Fee/sponsor intermingling | Separate ledger buckets | `SponsorBalance`, `FeeLiability` | `total_raised == SponsorBalance` |
| 3 | Matching double-spend | Idempotency + atomic debit | `MatchingClaimUsed`, `MatchingBalance` | One claim per contributor |
| 4 | No delegation constraints | Nonce-scoped grants | `Delegate`, `DelegatorNonce` | No unrestricted approvals |

All fixes are implemented in `/workspaces/stellar_client_os/contracts/campaign-funding/src/lib.rs` with 2645 lines of code including comprehensive tests.
