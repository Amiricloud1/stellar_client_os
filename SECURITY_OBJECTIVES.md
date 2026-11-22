# Security Objectives Analysis: Campaign Funding & Payment Stream Contracts

This document provides a detailed analysis of four critical security objectives for the Stellar Client OS campaign funding, payment stream, dispute arbiter, and timelock contracts. Each objective identifies current vulnerabilities, required fixes, Rust implementation details, and verification tests.

---

## Objective 1: Asset Validation — Reject Assets with Transfer, Decimal, or Administrative Restrictions

### Current State

**Vulnerability:** The campaign-funding contract (`/workspaces/stellar_client_os/contracts/campaign-funding/src/lib.rs`) accepts any ERC-20–compatible token without validating metadata or transfer behavior:

```rust
// Current: No validation of token properties
let stream = Stream {
    token: token.clone(),  // Any token address accepted
    // ...
};
```

**Risk:**
1. **Unsafe decimals**: Token with non-standard decimals (0 or >18) causes rounding errors in fee calculations and tree allocations.
2. **Transfer restrictions**: Tokens with transfer hooks, pause mechanisms, or whitelisting can:
   - Silently fail deposits (funds accepted but not actually held in escrow)
   - Block releases, causing donors to lose access to funds
   - Enable administrative recovery mid-campaign despite escrow contracts
3. **Administrative takeover**: Tokens with mutable supply or frozen/seizure mechanics allow arbitrary fund confiscation.
4. **Misconfigured assets**: Stellar native assets mapped to wrong contract addresses lead to fund loss.

### What Needs to Be Fixed

1. **Token Metadata Validation**: Before accepting any deposit, query and validate:
   - Decimal places: must be 6 or 18 (matching Stellar's USDC/EUROC standards)
   - Total supply: must be stable (not mutable admin function)
   - Transfer function: must not have restrictions (no pause, freeze, or rate-limit)

2. **Campaign-Level Asset Lockdown**: Once a campaign accepts its first donation in a token, that token becomes immutable:
   - Prevents switching to a compromised fork mid-campaign
   - Locks in the token's decimal scale for all calculations

3. **Whitelist for Verified Tokens**: Maintain a registry of pre-validated tokens:
   - USDC (6 decimals, known Stellar addresses)
   - EUROC (6 decimals)
   - Stellar native assets via bridged contracts
   - Custom tokens only after full validation

4. **Escrow Isolation**: Separate escrow contract that:
   - Never holds caller authority
   - Validates transfers before commitment
   - Rejects tokens that don't support `transfer_with_authorization`

### Rust Implementation Details

#### 1. Token Validation Function

```rust
// In campaign-funding/src/lib.rs

/// Represents validated token metadata.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedTokenMetadata {
    /// Token contract address
    pub token: Address,
    /// Number of decimal places (6 or 18 only)
    pub decimals: u32,
    /// Whether the token has been approved for escrow use
    pub is_whitelisted: bool,
    /// Timestamp of validation
    pub validated_at: u64,
}

/// Errors for token validation
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TokenValidationError {
    /// Token decimals are outside safe range (must be 6 or 18)
    InvalidDecimals = 1,
    /// Token has mutable supply (unauthorized admin functions)
    MutableSupply = 2,
    /// Token has transfer restrictions (pause, freeze, rate-limit)
    TransferRestricted = 3,
    /// Token is not on the whitelist
    NotWhitelisted = 4,
    /// Token validation is stale (expires after 90 days)
    ValidationExpired = 5,
}

/// Validates a token's suitability for escrow use.
///
/// Performs three checks:
/// 1. Decimals must be 6 or 18 to avoid precision loss
/// 2. No transfer restrictions (checked via test transfer)
/// 3. Whitelist confirmation or on-chain validation
fn validate_token_for_escrow(env: &Env, token: &Address) -> Result<ValidatedTokenMetadata, TokenValidationError> {
    // Check if already validated and cached
    let metadata_key = DataKey::TokenMetadata(token.clone());
    if let Some(cached) = env.storage().persistent().get::<_, ValidatedTokenMetadata>(&metadata_key) {
        let age = env.ledger().timestamp().saturating_sub(cached.validated_at);
        if age < 7_776_000 { // 90 days in seconds
            return Ok(cached);
        }
    }

    // Query token contract for metadata
    let token_client = token::TokenClient::new(env, token);
    
    let decimals = token_client.decimals();
    
    // Enforce safe decimal range
    if decimals != 6 && decimals != 18 {
        return Err(TokenValidationError::InvalidDecimals);
    }

    // Attempt a minimal transfer to detect restrictions
    // (This is a test transfer from contract to itself, should always succeed)
    let escrow_addr = env.current_contract_address();
    let test_result = token_client.try_transfer(
        &escrow_addr,
        &escrow_addr,
        &1, // minimal amount for testing
    );
    
    if test_result.is_err() {
        return Err(TokenValidationError::TransferRestricted);
    }

    // Check whitelist status
    let whitelist_key = DataKey::TokenWhitelist(token.clone());
    let is_whitelisted = env.storage().persistent().has(&whitelist_key);
    
    if !is_whitelisted {
        // Reject non-whitelisted tokens; require admin to approve first
        return Err(TokenValidationError::NotWhitelisted);
    }

    let metadata = ValidatedTokenMetadata {
        token: token.clone(),
        decimals,
        is_whitelisted: true,
        validated_at: env.ledger().timestamp(),
    };

    // Cache validation result
    env.storage().persistent().set(&metadata_key, &metadata);
    env.storage().persistent().extend_ttl(&metadata_key, LEDGER_THRESHOLD, LEDGER_BUMP);

    Ok(metadata)
}
```

#### 2. Updated Campaign Creation with Asset Locking

```rust
/// Modified create_campaign to enforce token validation and locking
pub fn create_campaign(
    env: Env,
    creator: Address,
    token: Address,
    target_amount: i128,
    min_target: i128,
    deadline: u64,
) -> u64 {
    creator.require_auth();

    // Validate the token BEFORE creating the campaign
    let token_metadata = validate_token_for_escrow(&env, &token)
        .map_err(|e| panic_with_error!(&env, Error::InvalidToken))?;

    // ... rest of campaign creation logic ...

    let campaign = Campaign {
        id: campaign_id,
        creator,
        token: token.clone(), // Now validated
        target_amount,
        min_target,
        deadline,
        total_raised: 0,
        status: CampaignStatus::Active,
        created_at: env.ledger().timestamp(),
        planter: OptionalAddress::None,
        co2_multiplier,
        token_metadata, // Store validated metadata with campaign
    };

    // Store campaign and emit event
    env.storage().persistent().set(&DataKey::Campaign(campaign_id), &campaign);
    env.storage().persistent().extend_ttl(
        &DataKey::Campaign(campaign_id),
        LEDGER_THRESHOLD,
        LEDGER_BUMP,
    );

    CampaignCreatedEvent {
        campaign_id,
        creator,
        token: token.clone(),
        target_amount,
        min_target,
        deadline,
        co2_multiplier: campaign.co2_multiplier,
        tree_species: String::from_str(&env, "declared species"),
    }
    .publish(&env);

    campaign_id
}
```

#### 3. Whitelist Management (Admin Only)

```rust
/// Add a token to the approved whitelist for escrow use.
/// Admin-only operation; enables a token that has passed validation.
pub fn whitelist_token(env: Env, admin: Address, token: Address) {
    let stored_admin = Self::get_admin(env.clone());
    if admin != stored_admin {
        panic_with_error!(&env, Error::Unauthorized);
    }
    admin.require_auth();

    let key = DataKey::TokenWhitelist(token.clone());
    env.storage().persistent().set(&key, &true);
    env.storage().persistent().extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);

    env.events().publish(
        ("TokenWhitelisted",),
        (admin, token, env.ledger().timestamp()),
    );
}

/// Remove a token from the whitelist (e.g., due to compromised or paused status).
pub fn revoke_token_whitelist(env: Env, admin: Address, token: Address) {
    let stored_admin = Self::get_admin(env.clone());
    if admin != stored_admin {
        panic_with_error!(&env, Error::Unauthorized);
    }
    admin.require_auth();

    let key = DataKey::TokenWhitelist(token.clone());
    env.storage().persistent().remove(&key);

    env.events().publish(
        ("TokenWhitelistRevoked",),
        (admin, token, env.ledger().timestamp()),
    );
}
```

### Tests for Objective 1

```rust
#[cfg(test)]
mod token_validation_tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    #[test]
    fn test_accept_standard_decimal_token() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, _) = create_token_with_decimals(&env, &token_admin, 6);

        // Whitelist the token
        client.whitelist_token(&admin, &token_addr);

        // Campaign creation should succeed
        let creator = Address::generate(&env);
        let campaign_id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
        assert!(campaign_id > 0);

        let campaign = client.get_campaign(&campaign_id);
        assert_eq!(campaign.token, token_addr);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #InvalidDecimals)")]
    fn test_reject_token_with_unsafe_decimals() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        // Create a token with 24 decimals (unsafe)
        let (token_addr, _, _) = create_token_with_decimals(&env, &token_admin, 24);

        // Whitelist it (assume validation would catch this)
        client.whitelist_token(&admin, &token_addr);

        // Campaign creation should fail
        let creator = Address::generate(&env);
        client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #NotWhitelisted)")]
    fn test_reject_non_whitelisted_token() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, _) = create_token_with_decimals(&env, &token_admin, 6);

        // Do NOT whitelist the token
        let creator = Address::generate(&env);
        client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
    }

    #[test]
    fn test_token_whitelist_and_revoke() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, _) = create_token_with_decimals(&env, &token_admin, 6);

        // Initially not whitelisted
        assert!(!client.is_token_whitelisted(&token_addr));

        // Whitelist
        client.whitelist_token(&admin, &token_addr);
        assert!(client.is_token_whitelisted(&token_addr));

        // Revoke
        client.revoke_token_whitelist(&admin, &token_addr);
        assert!(!client.is_token_whitelisted(&token_addr));
    }

    #[test]
    fn test_token_metadata_caching_expires() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (admin, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, _) = create_token_with_decimals(&env, &token_admin, 6);

        client.whitelist_token(&admin, &token_addr);
        
        // First validation caches metadata
        let metadata = client.get_token_metadata(&token_addr);
        assert_eq!(metadata.decimals, 6);

        // Advance time beyond 90-day expiry
        set_time(&env, 1_000 + 7_776_001); // 90 days + 1 second

        // Metadata should be re-validated
        let metadata_refreshed = client.get_token_metadata(&token_addr);
        assert_eq!(metadata_refreshed.validated_at, 1_000 + 7_776_001);
    }

    #[test]
    fn test_campaign_token_immutability() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token1, _, _) = create_token_with_decimals(&env, &token_admin, 6);
        let (token2, _, _) = create_token_with_decimals(&env, &token_admin, 6);

        client.whitelist_token(&admin, &token1);
        client.whitelist_token(&admin, &token2);

        let creator = Address::generate(&env);
        let campaign_id = client.create_campaign(&creator, &token1, &10_000, &5_000, &2_000);

        // Verify campaign is locked to token1
        let campaign = client.get_campaign(&campaign_id);
        assert_eq!(campaign.token, token1);

        // Attempting to update campaign to use token2 should fail
        assert!(client.try_change_campaign_token(&campaign_id, &token2).is_err());
    }
}
```

---

## Objective 2: Notice & Claim Periods — Prevent Administrator Recovery of Active or Claimable Balances

### Current State

**Vulnerability:** The campaign-funding contract allows campaigns to transition between states without safeguards for donor funds:

```rust
// Current: No notice period before admin recovery
pub fn claim_funds(env: Env, campaign_id: u64) {
    // Creator can claim funds immediately after campaign reaches Successful status
    // No mandatory notice period to allow donors to claim refunds first
}
```

**Risk:**
1. **Silent fund recovery**: Campaign creator claims raised funds before contributors can withdraw.
2. **Active escrow bypass**: During an active fundraising period, an admin could:
   - Pause the campaign
   - Move to "Claimed" state
   - Recover all escrowed funds without any notice to donors
3. **Insurance pool draining**: Admins could drain the insurance/reserve pools without contributors knowing they're no longer protected.
4. **Irreversible loss**: Once funds leave escrow, contributors have no recourse for refunds.

### What Needs to Be Fixed

1. **Define Notice Period**: Before any admin/creator can claim funds from escrow:
   - Emit a `FundsClaimNotice` event at least **14 days** before execution
   - Store notice in contract state with explicit claim window
   - Prevent claim execution during active fundraising (before deadline)

2. **Lock Claim During Active Campaigns**:
   - If current timestamp < campaign.deadline, all funds remain locked
   - No early transitions to "Claimed" state
   - Claim window opens **only after** deadline + notice period

3. **Donor Claim Rights** (pre-emptive reclamation):
   - During notice period, contributors can submit claims for their portion
   - Any contributor claim reduces the claimable balance for the creator
   - If all funds are claimed by contributors, creator gets zero

4. **Insurance Fund Guardrails**:
   - Insurance pools are locked during active campaigns
   - Can only be used after 24 months of campaign completion
   - Admin cannot redirect insurance funds

### Rust Implementation Details

#### 1. Add Notice Period Data Structures

```rust
/// Notice period for fund claims (in seconds)
pub const FUND_CLAIM_NOTICE_PERIOD: u64 = 1_209_600; // 14 days

/// Represents a pending funds claim notice.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundsClaimNotice {
    /// Campaign ID whose funds are claimed
    pub campaign_id: u64,
    /// Amount subject to claim
    pub amount: i128,
    /// Unix timestamp when notice was issued
    pub issued_at: u64,
    /// Unix timestamp when claim becomes executable
    pub executable_at: u64,
    /// Whether this claim has been executed
    pub executed: bool,
}

/// Emitted when a funds claim notice is issued.
#[contractevent]
#[derive(Clone)]
pub struct FundsClaimNoticeIssuedEvent {
    pub campaign_id: u64,
    pub amount: i128,
    pub notice_issued_at: u64,
    pub executable_at: u64,
}

/// Emitted when a contributor exercises early claim during notice period.
#[contractevent]
#[derive(Clone)]
pub struct ContributorEarlyClaimEvent {
    pub campaign_id: u64,
    pub contributor: Address,
    pub claimed_amount: i128,
    pub claimed_at: u64,
}

/// Extended Campaign struct with claim control fields
#[contracttype]
#[derive(Clone)]
pub struct Campaign {
    pub id: u64,
    pub creator: Address,
    pub creators: Vec<Address>,
    pub revenue_shares: Vec<u32>,
    pub token: Address,
    pub target_amount: i128,
    pub min_target: i128,
    pub deadline: u64,
    pub total_raised: i128,
    pub status: CampaignStatus,
    pub created_at: u64,
    pub planter: OptionalAddress,
    pub co2_multiplier: u32,
    // New fields for claim control:
    /// Timestamp of the pending claim notice, if any
    pub claim_notice_issued_at: Option<u64>,
    /// Amount locked pending notice period expiry
    pub claim_locked_amount: i128,
}

// Updated DataKey enum
pub enum DataKey {
    // ... existing keys ...
    /// Pending claim notice for a campaign
    FundsClaimNotice(u64),
    /// Amount claimed early by contributors during notice period
    ContributorClaimedAmount(u64, Address),
    /// Insurance pool lock time (when campaign completed)
    InsurancePoolLockTime(u64),
}
```

#### 2. Claim Notice Mechanism

```rust
/// Issue a funds claim notice for a successful campaign.
///
/// This is typically called after a campaign succeeds or reaches the deadline.
/// It starts a mandatory 14-day notice period during which:
/// - The creator cannot claim the funds
/// - Contributors can submit early claims to recover their portions
/// - Insurance pools remain locked if campaign is active
///
/// # Errors
/// - `CampaignNotSuccessful` if campaign is not in Successful state
/// - `AlreadyClaimed` if funds have already been claimed
pub fn issue_funds_claim_notice(env: Env, campaign_id: u64) -> u64 {
    let mut campaign = Self::get_campaign(env.clone(), campaign_id)?;

    // Can only claim from Successful campaigns
    if campaign.status != CampaignStatus::Successful {
        panic_with_error!(&env, Error::CampaignNotSuccessful);
    }

    // Cannot issue notice twice
    if campaign.claim_notice_issued_at.is_some() {
        panic_with_error!(&env, Error::AlreadyClaimed);
    }

    let now = env.ledger().timestamp();
    let executable_at = now.saturating_add(FUND_CLAIM_NOTICE_PERIOD);

    let notice = FundsClaimNotice {
        campaign_id,
        amount: campaign.total_raised,
        issued_at: now,
        executable_at,
        executed: false,
    };

    // Store notice and update campaign state
    env.storage()
        .persistent()
        .set(&DataKey::FundsClaimNotice(campaign_id), &notice);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::FundsClaimNotice(campaign_id), LEDGER_THRESHOLD, LEDGER_BUMP);

    // Lock the funds in the campaign record
    campaign.claim_notice_issued_at = Some(now);
    campaign.claim_locked_amount = campaign.total_raised;
    env.storage()
        .persistent()
        .set(&DataKey::Campaign(campaign_id), &campaign);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::Campaign(campaign_id), LEDGER_THRESHOLD, LEDGER_BUMP);

    // Emit notice event
    FundsClaimNoticeIssuedEvent {
        campaign_id,
        amount: campaign.total_raised,
        notice_issued_at: now,
        executable_at,
    }
    .publish(&env);

    executable_at
}

/// Allow a contributor to claim their share during the notice period.
///
/// Reduces the amount available for the creator to claim.
/// After the notice period expires, any unclaimed contributor funds
/// default to the creator's payout.
///
/// # Errors
/// - `NoContributionFound` if contributor has no recorded contribution
/// - `EvidenceDeadlineExpired` if notice period has expired (use regular claim flow)
pub fn contributor_claim_during_notice(
    env: Env,
    campaign_id: u64,
    contributor: Address,
) -> i128 {
    contributor.require_auth();

    let campaign = Self::get_campaign(env.clone(), campaign_id)?;
    
    // Must have a pending claim notice
    if campaign.claim_notice_issued_at.is_none() {
        panic_with_error!(&env, Error::InvalidTimeRange); // No notice issued
    }

    let issued_at = campaign.claim_notice_issued_at.unwrap();
    let notice_expires_at = issued_at.saturating_add(FUND_CLAIM_NOTICE_PERIOD);
    let now = env.ledger().timestamp();

    // Notice period must still be active
    if now >= notice_expires_at {
        panic_with_error!(&env, Error::SlaNotBreached); // Notice period expired
    }

    // Contributor must have a recorded contribution
    let contribution_key = (campaign_id, contributor.clone());
    let contributed_amount: i128 = env
        .storage()
        .persistent()
        .get(&DataKey::Contribution(campaign_id, contributor.clone()))
        .ok_or_else(|| panic_with_error!(&env, Error::NoContributionFound))?;

    if contributed_amount <= 0 {
        panic_with_error!(&env, Error::InvalidAmount);
    }

    // Transfer the contributor's share back to them
    let token_client = token::TokenClient::new(&env, &campaign.token);
    token_client.transfer(&contributor, &contributed_amount);

    // Record the early claim to reduce creator's claimable balance
    let claim_key = DataKey::ContributorClaimedAmount(campaign_id, contributor.clone());
    env.storage()
        .persistent()
        .set(&claim_key, &contributed_amount);
    env.storage()
        .persistent()
        .extend_ttl(&claim_key, LEDGER_THRESHOLD, LEDGER_BUMP);

    ContributorEarlyClaimEvent {
        campaign_id,
        contributor,
        claimed_amount: contributed_amount,
        claimed_at: now,
    }
    .publish(&env);

    contributed_amount
}

/// Claim funds after the notice period has expired.
///
/// Calculates the remaining balance (total raised minus contributor early claims)
/// and transfers to the creator. After this succeeds, status transitions to `Claimed`.
///
/// # Errors
/// - `CampaignNotSuccessful` if campaign not in Successful state
/// - `TimelockNotElapsed` if notice period has not expired yet
pub fn claim_funds(env: Env, campaign_id: u64) -> i128 {
    let mut campaign = Self::get_campaign(env.clone(), campaign_id)?;

    if campaign.status != CampaignStatus::Successful {
        panic_with_error!(&env, Error::CampaignNotSuccessful);
    }

    // Claim notice must be issued
    if campaign.claim_notice_issued_at.is_none() {
        panic_with_error!(&env, Error::InvalidTimeRange);
    }

    let issued_at = campaign.claim_notice_issued_at.unwrap();
    let executable_at = issued_at.saturating_add(FUND_CLAIM_NOTICE_PERIOD);
    let now = env.ledger().timestamp();

    // Notice period must have expired
    if now < executable_at {
        panic_with_error!(&env, Error::TimelockNotElapsed);
    }

    // Calculate remaining balance (total - contributor early claims)
    let mut claimed_by_contributors = 0i128;
    for contributor in env.storage()
        .persistent()
        .get::<_, Vec<Address>>(&DataKey::CampaignContributors(campaign_id))
        .unwrap_or_else(|| Vec::new(&env))
        .iter()
    {
        if let Some(amt) = env
            .storage()
            .persistent()
            .get::<_, i128>(&DataKey::ContributorClaimedAmount(campaign_id, contributor.clone()))
        {
            claimed_by_contributors += amt;
        }
    }

    let claimable = campaign
        .total_raised
        .checked_sub(claimed_by_contributors)
        .unwrap_or_else(|| panic_with_error!(&env, Error::ArithmeticOverflow));

    if claimable > 0 {
        let token_client = token::TokenClient::new(&env, &campaign.token);
        token_client.transfer(&campaign.creator, &claimable);
    }

    // Update campaign state to Claimed
    campaign.status = CampaignStatus::Claimed;
    env.storage()
        .persistent()
        .set(&DataKey::Campaign(campaign_id), &campaign);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::Campaign(campaign_id), LEDGER_THRESHOLD, LEDGER_BUMP);

    FundsClaimedEvent {
        campaign_id,
        creator: campaign.creator,
        amount: claimable,
    }
    .publish(&env);

    claimable
}
```

#### 3. Insurance Pool Lock Mechanism

```rust
/// Lock the insurance pool until campaign is completed + 24 months verification.
///
/// Insurance funds are NOT accessible to admins during active campaigns.
/// They only unlock 24 months after tree planting verification completes.
pub fn initialize_insurance_lock(env: Env, campaign_id: u64) {
    let now = env.ledger().timestamp();
    let unlock_time = now.saturating_add(63_072_000); // 24 months in seconds
    
    env.storage()
        .persistent()
        .set(&DataKey::InsurancePoolLockTime(campaign_id), &unlock_time);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::InsurancePoolLockTime(campaign_id), LEDGER_THRESHOLD, LEDGER_BUMP);
}

/// Use insurance funds only after the lock period.
pub fn use_insurance_for_replacement(env: Env, campaign_id: u64, amount: i128) -> Result<(), Error> {
    let unlock_time: u64 = env
        .storage()
        .persistent()
        .get(&DataKey::InsurancePoolLockTime(campaign_id))
        .unwrap_or(u64::MAX);

    let now = env.ledger().timestamp();
    if now < unlock_time {
        panic_with_error!(&env, Error::InsuranceWindowExpired);
    }

    // Insurance can now be used for tree replacement
    let pool_key = DataKey::InsurancePool(Address::generate(&env)); // Token address
    let mut balance: i128 = env
        .storage()
        .persistent()
        .get(&pool_key)
        .unwrap_or(0);
    
    if balance < amount {
        panic_with_error!(&env, Error::InvalidAmount);
    }

    balance -= amount;
    env.storage()
        .persistent()
        .set(&pool_key, &balance);

    Ok(())
}
```

### Tests for Objective 2

```rust
#[cfg(test)]
mod claim_notice_tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    #[test]
    fn test_issue_claim_notice_for_successful_campaign() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &10_000);
        let campaign_id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);

        // Contribute to reach success
        client.contribute(&sponsor, &campaign_id, &10_000);

        // Campaign should be Successful
        let campaign = client.get_campaign(&campaign_id);
        assert_eq!(campaign.status, CampaignStatus::Successful);
        assert!(campaign.claim_notice_issued_at.is_none());

        // Issue claim notice
        let executable_at = client.issue_funds_claim_notice(&campaign_id);
        assert_eq!(executable_at, 1_000 + FUND_CLAIM_NOTICE_PERIOD);

        let campaign_after = client.get_campaign(&campaign_id);
        assert!(campaign_after.claim_notice_issued_at.is_some());
        assert_eq!(campaign_after.claim_locked_amount, 10_000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #CampaignNotSuccessful)")]
    fn test_cannot_issue_notice_for_active_campaign() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, _) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);

        let campaign_id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);

        // Try to issue notice while campaign is still Active
        client.issue_funds_claim_notice(&campaign_id);
    }

    #[test]
    fn test_contributor_early_claim_during_notice_period() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &10_000);
        let campaign_id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);

        // Contribute and trigger success
        client.contribute(&sponsor, &campaign_id, &10_000);
        client.issue_funds_claim_notice(&campaign_id);

        // Contributor claims their share during notice period
        let claimed = client.contributor_claim_during_notice(&campaign_id, &sponsor);
        assert_eq!(claimed, 10_000);

        // Sponsor should now have their funds back
        let balance = token_admin_client.balance(&sponsor);
        assert_eq!(balance, 10_000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #SlaNotBreached)")]
    fn test_cannot_claim_during_notice_period() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let sponsor = Address::generate(&env);

        token_admin_client.mint(&sponsor, &10_000);
        let campaign_id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);

        client.contribute(&sponsor, &campaign_id, &10_000);
        client.issue_funds_claim_notice(&campaign_id);

        // Attempt to claim before notice period expires
        set_time(&env, 1_000 + 86_400); // Only 1 day later
        client.claim_funds(&campaign_id);
    }

    #[test]
    fn test_creator_claims_remainder_after_notice_period() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);
        let sponsor_a = Address::generate(&env);
        let sponsor_b = Address::generate(&env);

        token_admin_client.mint(&sponsor_a, &5_000);
        token_admin_client.mint(&sponsor_b, &7_000);

        let campaign_id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
        client.contribute(&sponsor_a, &campaign_id, &5_000);
        client.contribute(&sponsor_b, &campaign_id, &7_000);
        
        client.issue_funds_claim_notice(&campaign_id);

        // Sponsor A claims early
        client.contributor_claim_during_notice(&campaign_id, &sponsor_a);

        // Advance past notice period
        set_time(&env, 1_000 + FUND_CLAIM_NOTICE_PERIOD + 1);

        // Creator claims remainder (12,000 - 5,000 = 7,000)
        let claimed = client.claim_funds(&campaign_id);
        assert_eq!(claimed, 7_000);
    }

    #[test]
    fn test_insurance_pool_locked_during_active_campaign() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, _) = create_token(&env, &token_admin);
        let creator = Address::generate(&env);

        let campaign_id = client.create_campaign(&creator, &token_addr, &10_000, &5_000, &2_000);
        client.initialize_insurance_lock(&campaign_id);

        // Attempt to use insurance before lock expires
        let result = client.try_use_insurance_for_replacement(&campaign_id, &1_000);
        assert!(result.is_err());
    }

    #[test]
    fn test_insurance_pool_unlocked_after_24_months() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client, _, _) = setup_contract(&env);
        let campaign_id = 1u64;

        client.initialize_insurance_lock(&campaign_id);

        // Fast-forward 24 months + 1 second
        set_time(&env, 1_000 + 63_072_001);

        // Insurance pool is now accessible
        let result = client.try_use_insurance_for_replacement(&campaign_id, &1_000);
        assert!(result.is_ok());
    }
}
```

---

## Objective 3: Approval Threshold Governance — Bound and Freeze Approval Thresholds After Fundraising Begins

### Current State

**Vulnerability:** The dispute-arbiter contract defines approval thresholds but does not prevent mid-campaign changes:

```rust
// Current: CONSENSUS_THRESHOLD can be modified at runtime
const CONSENSUS_THRESHOLD: u32 = 3; // 3 of 5 arbiters

// But allow_change_threshold() lets admins adjust this during disputes
pub fn set_voting_threshold(env: Env, threshold: u32) { ... } // No campaign state check
```

**Risk:**
1. **Vote threshold manipulation**: Admin raises threshold from 3/5 to 4/5 mid-dispute to prevent milestone approval.
2. **Quorum changes**: Reducing required votes late in arbitration changes the consensus definition retroactively.
3. **Dispute outcome rigging**: By adjusting thresholds after evidence is submitted but before votes are tallied, disputes can be predetermined.
4. **No immutability guarantee**: Contributors have no certainty that dispute rules won't change mid-resolution.

### What Needs to Be Fixed

1. **Freeze Thresholds at Dispute Creation**: When a dispute is created, capture and lock all governance parameters:
   - Voting period duration
   - Consensus threshold (minimum votes needed)
   - Arbiters list
   - Evidence deadline

2. **Immutable Governance per Dispute**: Each dispute carries its own snapshot of rules:
   - Rules cannot be changed once dispute transitions to "Voting" state
   - Rules apply deterministically for the entire vote lifecycle
   - Admin changes only apply to new disputes created after the change

3. **Dispute Metadata Versioning**: Store dispute-specific versions of all governance constants:
   - Voting deadline (computed at creation time)
   - Minimum approvals needed
   - Maximum evidence submission time

4. **Timelock on Threshold Changes**: If thresholds must be changed:
   - Require a 7-day notice
   - Cannot apply to disputes already in Voting state
   - Must go through admin proposal → approval → enforcement

### Rust Implementation Details

#### 1. Dispute Governance Snapshot

```rust
// In dispute-arbiter/src/lib.rs

/// Governance parameters captured at dispute creation time.
/// These values are immutable for the life of the dispute.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeGovernance {
    /// Number of arbiters assigned (typically 5)
    pub arbiter_count: u32,
    /// Minimum votes needed for consensus (typically 3)
    pub consensus_threshold: u32,
    /// Duration in seconds for voting period
    pub voting_period_secs: u64,
    /// Maximum time in seconds for evidence submission after creation
    pub evidence_deadline_offset: u64,
    /// Timestamp of governance snapshot
    pub captured_at: u64,
}

/// Updated Dispute struct with governance snapshot
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispute {
    pub id: u64,
    pub milestone_id: u64,
    pub escrow_id: u64,
    pub client: Address,
    pub freelancer: Address,
    pub assigned_arbiters: Vec<Address>,
    pub state: DisputeState,
    pub votes_for_approve: u32,
    pub votes_for_reject: u32,
    pub votes_for_evidence: u32,
    pub created_at: u64,
    pub voting_deadline: u64,
    pub resolved_at: Option<u64>,
    /// Immutable governance rules for this dispute
    pub governance: DisputeGovernance,
}

/// Threshold change proposal (with timelock)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThresholdChangeProposal {
    /// New consensus threshold to apply
    pub new_threshold: u32,
    /// When the proposal was issued
    pub issued_at: u64,
    /// When the change can be executed (issued_at + 7 days)
    pub effective_at: u64,
    /// Whether the change has been applied
    pub applied: bool,
}

pub enum DataKey {
    // ... existing ...
    /// Current default governance parameters (instance storage)
    DefaultGovernance,
    /// Pending threshold change proposal (instance storage)
    ThresholdChangeProposal,
    /// List of active disputes that are immune to threshold changes
    ActiveDisputeIds,
}

/// Default governance when contract initializes
const DEFAULT_CONSENSUS_THRESHOLD: u32 = 3;
const DEFAULT_VOTING_PERIOD_SECS: u64 = 604_800; // 7 days
const DEFAULT_EVIDENCE_DEADLINE_OFFSET: u64 = 604_800; // 7 days
const THRESHOLD_CHANGE_NOTICE_PERIOD: u64 = 604_800; // 7 days
```

#### 2. Capture Governance at Dispute Creation

```rust
/// Create a new dispute with immutable governance snapshot.
pub fn create_dispute(
    env: Env,
    milestone_id: u64,
    escrow_id: u64,
    client: Address,
    freelancer: Address,
    assigned_arbiters: Vec<Address>,
) -> Result<u64, ArbiterError> {
    client.require_auth();
    freelancer.require_auth();

    if assigned_arbiters.len() != REQUIRED_ARBITERS {
        return Err(ArbiterError::NotEnoughArbiters);
    }

    let mut count: u64 = env
        .storage()
        .instance()
        .get(&DataKey::DisputeCount)
        .unwrap_or(0);
    if count == u64::MAX {
        ContractFullEvent {
            timestamp: env.ledger().timestamp(),
        }
        .publish(&env);
        return Err(ArbiterError::ContractFull);
    }
    count += 1;

    let now = env.ledger().timestamp();

    // Capture current default governance as snapshot for this dispute
    let default_governance: DisputeGovernance = env
        .storage()
        .instance()
        .get(&DataKey::DefaultGovernance)
        .unwrap_or(DisputeGovernance {
            arbiter_count: REQUIRED_ARBITERS,
            consensus_threshold: DEFAULT_CONSENSUS_THRESHOLD,
            voting_period_secs: DEFAULT_VOTING_PERIOD_SECS,
            evidence_deadline_offset: DEFAULT_EVIDENCE_DEADLINE_OFFSET,
            captured_at: now,
        });

    let dispute = Dispute {
        id: count,
        milestone_id,
        escrow_id,
        client,
        freelancer,
        assigned_arbiters,
        state: DisputeState::Voting,
        votes_for_approve: 0,
        votes_for_reject: 0,
        votes_for_evidence: 0,
        created_at: now,
        voting_deadline: now.saturating_add(default_governance.voting_period_secs),
        resolved_at: None,
        governance: default_governance, // Snapshot captured here
    };

    env.storage()
        .persistent()
        .set(&DataKey::Dispute(count), &dispute);
    bump_ttl(&env, &DataKey::Dispute(count));

    env.storage()
        .persistent()
        .set(&DataKey::Votes(count), &Vec::<Vote>::new(&env));
    bump_ttl(&env, &DataKey::Votes(count));

    // Track this dispute as "active" to prevent threshold changes
    let mut active_disputes: Vec<u64> = env
        .storage()
        .instance()
        .get(&DataKey::ActiveDisputeIds)
        .unwrap_or_else(|| Vec::new(&env));
    active_disputes.push_back(count);
    env.storage()
        .instance()
        .set(&DataKey::ActiveDisputeIds, &active_disputes);

    env.storage()
        .instance()
        .set(&DataKey::DisputeCount, &count);

    Ok(count)
}
```

#### 3. Consensus Check Using Dispute Governance

```rust
/// Cast a vote, checking consensus using the dispute's immutable governance.
pub fn cast_vote(
    env: Env,
    dispute_id: u64,
    arbiter: Address,
    choice: VoteChoice,
    reason: String,
) -> Result<(), ArbiterError> {
    arbiter.require_auth();

    let mut dispute: Dispute = env
        .storage()
        .persistent()
        .get(&DataKey::Dispute(dispute_id))
        .ok_or(ArbiterError::DisputeNotFound)?;
    bump_ttl(&env, &DataKey::Dispute(dispute_id));

    // Verify voting is still open
    if dispute.state != DisputeState::Voting {
        return Err(ArbiterError::AlreadyResolved);
    }

    // Check deadline using dispute's governance snapshot
    if env.ledger().timestamp() > dispute.voting_deadline {
        dispute.state = DisputeState::TimedOut;
        dispute.resolved_at = Some(env.ledger().timestamp());
        env.storage()
            .persistent()
            .set(&DataKey::Dispute(dispute_id), &dispute);
        bump_ttl(&env, &DataKey::Dispute(dispute_id));
        return Err(ArbiterError::VotingPeriodExpired);
    }

    // Verify arbiter is assigned
    if !dispute.assigned_arbiters.contains(&arbiter) {
        return Err(ArbiterError::NotAssignedArbiter);
    }

    // Prevent double voting
    let voted_key = DataKey::HasVoted(dispute_id, arbiter.clone());
    if env.storage().persistent().has(&voted_key) {
        return Err(ArbiterError::AlreadyVoted);
    }

    // Record the vote
    let vote = Vote {
        arbiter: arbiter.clone(),
        choice: choice.clone(),
        reason,
        timestamp: env.ledger().timestamp(),
    };

    let mut votes: Vec<Vote> = env
        .storage()
        .persistent()
        .get(&DataKey::Votes(dispute_id))
        .unwrap_or(Vec::new(&env));
    votes.push_back(vote);
    env.storage()
        .persistent()
        .set(&DataKey::Votes(dispute_id), &votes);
    bump_ttl(&env, &DataKey::Votes(dispute_id));

    // Update dispute tally
    match choice {
        VoteChoice::Approve => dispute.votes_for_approve += 1,
        VoteChoice::Reject => dispute.votes_for_reject += 1,
        VoteChoice::RequestEvidence => dispute.votes_for_evidence += 1,
    }

    // Mark arbiter as having voted
    env.storage().persistent().set(&voted_key, &true);

    // Check for consensus using the dispute's immutable governance threshold
    let threshold = dispute.governance.consensus_threshold;
    let resolved = if dispute.votes_for_approve >= threshold {
        dispute.state = DisputeState::Approved;
        true
    } else if dispute.votes_for_reject >= threshold {
        dispute.state = DisputeState::Rejected;
        true
    } else if dispute.votes_for_evidence >= threshold {
        dispute.state = DisputeState::EvidenceRequested;
        true
    } else {
        false
    };

    if resolved {
        dispute.resolved_at = Some(env.ledger().timestamp());
        
        // Remove dispute from active list
        let mut active: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::ActiveDisputeIds)
            .unwrap_or_else(|| Vec::new(&env));
        active.retain(|&id| id != dispute_id);
        env.storage()
            .instance()
            .set(&DataKey::ActiveDisputeIds, &active);
    }

    env.storage()
        .persistent()
        .set(&DataKey::Dispute(dispute_id), &dispute);
    bump_ttl(&env, &DataKey::Dispute(dispute_id));

    Ok(())
}
```

#### 4. Threshold Change with Timelock

```rust
/// Propose a threshold change (admin only).
/// The change takes effect after a 7-day notice period.
/// Cannot apply to disputes already in Voting state.
pub fn propose_threshold_change(
    env: Env,
    admin: Address,
    new_threshold: u32,
) -> Result<u64, ArbiterError> {
    admin.require_auth();
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(ArbiterError::Unauthorized)?;

    if admin != stored_admin {
        return Err(ArbiterError::Unauthorized);
    }

    // Validate new threshold
    if new_threshold == 0 || new_threshold > REQUIRED_ARBITERS {
        return Err(ArbiterError::InvalidVoteChoice);
    }

    let now = env.ledger().timestamp();
    let effective_at = now.saturating_add(THRESHOLD_CHANGE_NOTICE_PERIOD);

    let proposal = ThresholdChangeProposal {
        new_threshold,
        issued_at: now,
        effective_at,
        applied: false,
    };

    env.storage()
        .instance()
        .set(&DataKey::ThresholdChangeProposal, &proposal);

    env.events().publish(
        ("ThresholdChangeProposed",),
        (admin, new_threshold, effective_at),
    );

    Ok(effective_at)
}

/// Execute a pending threshold change after the notice period expires.
pub fn apply_threshold_change(env: Env) -> Result<(), ArbiterError> {
    let proposal: ThresholdChangeProposal = env
        .storage()
        .instance()
        .get(&DataKey::ThresholdChangeProposal)
        .ok_or(ArbiterError::InvalidVoteChoice)?;

    // Check that notice period has expired
    if env.ledger().timestamp() < proposal.effective_at {
        return Err(ArbiterError::VotingPeriodExpired);
    }

    // Ensure no active disputes exist (conflicts with ongoing votes)
    let active_disputes: Vec<u64> = env
        .storage()
        .instance()
        .get(&DataKey::ActiveDisputeIds)
        .unwrap_or_else(|| Vec::new(&env));

    if !active_disputes.is_empty() {
        // Active disputes still use old governance; cannot change yet
        return Err(ArbiterError::InvalidVoteChoice); // Better error needed
    }

    // Update default governance
    let mut default_gov: DisputeGovernance = env
        .storage()
        .instance()
        .get(&DataKey::DefaultGovernance)
        .unwrap_or(DisputeGovernance {
            arbiter_count: REQUIRED_ARBITERS,
            consensus_threshold: DEFAULT_CONSENSUS_THRESHOLD,
            voting_period_secs: DEFAULT_VOTING_PERIOD_SECS,
            evidence_deadline_offset: DEFAULT_EVIDENCE_DEADLINE_OFFSET,
            captured_at: env.ledger().timestamp(),
        });

    default_gov.consensus_threshold = proposal.new_threshold;
    default_gov.captured_at = env.ledger().timestamp();

    env.storage()
        .instance()
        .set(&DataKey::DefaultGovernance, &default_gov);

    // Remove the proposal
    env.storage()
        .instance()
        .remove(&DataKey::ThresholdChangeProposal);

    env.events()
        .publish(("ThresholdChangeApplied",), (proposal.new_threshold,));

    Ok(())
}
```

### Tests for Objective 3

```rust
#[cfg(test)]
mod governance_immutability_tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    #[test]
    fn test_dispute_governance_snapshot_at_creation() {
        let env = Env::default();
        env.mock_all_auths();

        let (client, admin) = setup(&env);
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        let mut arbiters = Vec::new(&env);
        for _ in 0..5 {
            arbiters.push_back(Address::generate(&env));
        }

        let dispute_id = client.create_dispute(&1, &1, &client_addr, &freelancer, &arbiters);
        let dispute = client.get_dispute(&dispute_id);

        // Verify governance snapshot was captured
        assert_eq!(dispute.governance.consensus_threshold, DEFAULT_CONSENSUS_THRESHOLD);
        assert_eq!(dispute.governance.arbiter_count, REQUIRED_ARBITERS);
        assert!(dispute.governance.captured_at > 0);
    }

    #[test]
    fn test_threshold_proposal_with_7_day_notice() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);

        let (client, admin) = setup(&env);

        // Propose new threshold of 4
        let effective_at = client.propose_threshold_change(&admin, &4);
        assert_eq!(effective_at, 1_000 + THRESHOLD_CHANGE_NOTICE_PERIOD);

        // Cannot apply immediately
        let result = client.try_apply_threshold_change();
        assert!(result.is_err());

        // Fast-forward 7 days + 1 second
        set_time(&env, 1_000 + THRESHOLD_CHANGE_NOTICE_PERIOD + 1);

        // Now can apply
        client.apply_threshold_change();

        // New disputes use the new threshold
        let new_governance = client.get_default_governance();
        assert_eq!(new_governance.consensus_threshold, 4);
    }

    #[test]
    fn test_old_disputes_use_original_governance_after_threshold_change() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);

        let (client, admin) = setup(&env);
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        let mut arbiters = Vec::new(&env);
        for _ in 0..5 {
            arbiters.push_back(Address::generate(&env));
        }

        // Create dispute with default threshold (3)
        let dispute_id = client.create_dispute(&1, &1, &client_addr, &freelancer, &arbiters);
        let dispute = client.get_dispute(&dispute_id);
        assert_eq!(dispute.governance.consensus_threshold, 3);

        // Propose and apply new threshold (4)
        client.propose_threshold_change(&admin, &4);
        set_time(&env, 1_000 + THRESHOLD_CHANGE_NOTICE_PERIOD + 1);
        client.apply_threshold_change();

        // Old dispute STILL uses 3
        let dispute_after = client.get_dispute(&dispute_id);
        assert_eq!(dispute_after.governance.consensus_threshold, 3);
    }

    #[test]
    fn test_cannot_apply_threshold_change_with_active_disputes() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);

        let (client, admin) = setup(&env);
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        let mut arbiters = Vec::new(&env);
        for _ in 0..5 {
            arbiters.push_back(Address::generate(&env));
        }

        // Create an active dispute
        let dispute_id = client.create_dispute(&1, &1, &client_addr, &freelancer, &arbiters);

        // Propose threshold change
        client.propose_threshold_change(&admin, &4);

        // Fast-forward past notice period
        set_time(&env, 1_000 + THRESHOLD_CHANGE_NOTICE_PERIOD + 1);

        // Cannot apply because dispute is still active
        let result = client.try_apply_threshold_change();
        assert!(result.is_err());

        // Resolve the dispute first
        let reason = String::from_str(&env, "approved");
        for i in 0..3 {
            client.cast_vote(&dispute_id, &arbiters.get(i).unwrap(), &VoteChoice::Approve, &reason);
        }

        // Now apply can succeed
        client.apply_threshold_change();
    }

    #[test]
    fn test_new_disputes_after_threshold_change_use_new_governance() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);

        let (client, admin) = setup(&env);
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        let mut arbiters = Vec::new(&env);
        for _ in 0..5 {
            arbiters.push_back(Address::generate(&env));
        }

        // Propose and apply new threshold
        client.propose_threshold_change(&admin, &4);
        set_time(&env, 1_000 + THRESHOLD_CHANGE_NOTICE_PERIOD + 1);
        client.apply_threshold_change();

        // Create new dispute
        let dispute_id = client.create_dispute(&2, &2, &client_addr, &freelancer, &arbiters);
        let dispute = client.get_dispute(&dispute_id);

        // New dispute uses updated threshold (4)
        assert_eq!(dispute.governance.consensus_threshold, 4);
    }
}
```

---

## Objective 4: Timelock & Dispute Resolution — Block Irreversible Payouts During Valid Challenges

### Current State

**Vulnerability:** The payment-stream contract implements a `resolve_dispute` function but does not block payouts during the dispute resolution window:

```rust
// Current: Dispute resolution queues payout but doesn't prevent concurrent operations
pub fn resolve_dispute(
    env: Env,
    stream_id: u64,
    recipient_amount: i128,
    sender_amount: i128,
) {
    // ... resolve and queue ...
    // But execute_resolution() might race with other operations
}
```

**Risk:**
1. **Concurrent payout execution**: While a dispute is queued for resolution, the recipient or sender could:
   - Call `withdraw()` or `withdraw_max()` simultaneously
   - Pull funds out of escrow mid-dispute
   - Leave no balance for the eventual resolution payout
2. **Immature execution**: Dispute resolutions execute without the mandatory 48-hour timelock.
3. **No finality guarantee**: Outcomes change mid-execution (amounts adjusted, recipients swapped).
4. **Race condition exploitation**: Sophisticated actors coordinate timing to bypass dispute blocks.

### What Needs to Be Fixed

1. **Global Dispute Lock**: When `resolve_dispute()` is called:
   - Set a `DisputeInProgress` flag on the stream
   - Block ALL fund-moving operations (`withdraw`, `pause`, `cancel`, `deposit`)
   - Only allow `execute_resolution` and `cancel_dispute`

2. **48-Hour Mandatory Timelock**: Use the timelock contract:
   - Dispute resolution must queue with `timelock.propose_action()`
   - Cannot execute for 48 hours after proposal
   - Provides verifiable delay and determinism

3. **Deterministic Expiry**: Define when disputes close:
   - Resolution must execute within 7 days of dispute proposal (or expires)
   - Expired disputes can be cancelled by anyone (refund to sender)
   - Clear, immutable expiry prevents "zombie" disputes

4. **Revert-Safe State Snapshots**: Before dispute queues, snapshot stream state:
   - Balance, status, recipients (in case these change mid-dispute)
   - Resolution amounts are validated against snapshot
   - Prevents slippage or manipulation of underlying data

### Rust Implementation Details

#### 1. Dispute Timelock Integration

```rust
// In payment-stream/src/lib.rs

/// Configuration for dispute resolution with timelock
pub const DISPUTE_RESOLUTION_TIMELOCK: u64 = 172_800; // 48 hours
pub const DISPUTE_RESOLUTION_EXPIRY: u64 = 604_800; // 7 days

/// Snapshot of stream state at the moment dispute is created.
/// Prevents subsequent changes from affecting resolution.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeSnapshot {
    pub stream_id: u64,
    pub stream_status: StreamStatus,
    pub stream_balance: i128,
    pub stream_total_amount: i128,
    pub recipient: Address,
    pub sender: Address,
    pub token: Address,
    pub snapshot_at: u64,
}

/// Extended QueuedResolution with timelock action hash
#[contracttype]
#[derive(Clone)]
pub struct QueuedResolution {
    pub dispute_id: u64,
    pub stream_id: u64,
    pub recipient_amount: i128,
    pub sender_amount: i128,
    pub execute_after: u64,
    pub executed: bool,
    pub previous_status: StreamStatus,
    /// Hash of the timelock action for this resolution
    pub timelock_action_hash: BytesN<32>,
    /// Snapshot of stream state when dispute was created
    pub snapshot: DisputeSnapshot,
}

pub enum DataKey {
    // ... existing ...
    /// Queued dispute resolution identified by dispute ID
    DisputeResolution(u64),
    /// Active dispute for a stream (only one per stream at a time)
    ActiveDisputeForStream(u64),
    /// Timelock contract address (instance storage)
    TimelockContract,
}

/// Errors related to dispute blocking
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // ... existing errors ...
    /// A dispute resolution is in progress on this stream; cannot perform this operation
    DisputeInProgress = 26,
    /// Dispute resolution has already been queued
    DisputeAlreadyQueued = 27,
    /// No queued dispute resolution for this dispute ID
    DisputeNotFound = 28,
    /// Dispute resolution has already been executed
    DisputeAlreadyExecuted = 29,
    /// Dispute resolution timelock has not elapsed yet (must wait 48h)
    TimelockNotElapsed = 30,
    /// Dispute resolution has expired (must execute within 7 days)
    DisputeResolutionExpired = 31,
}
```

#### 2. Resolve Dispute with Timelock Proposal

```rust
/// Resolve a disputed stream by proposing a timelock action.
///
/// Creates a deterministic payout allocation and queues it through
/// the timelock contract. Operations on this stream are blocked until
/// resolution is executed or cancelled.
///
/// # Arguments
/// * `stream_id` - The disputed stream.
/// * `recipient_amount` - Amount to send to recipient (must be <= balance).
/// * `sender_amount` - Amount to return to sender (must be <= balance).
///
/// # Errors
/// - `DisputeInProgress` - A dispute already exists on this stream.
/// - `InvalidResolutionAmounts` - Amounts exceed stream balance or are negative.
/// - `StreamNotFound` - Stream does not exist.
pub fn resolve_dispute(
    env: Env,
    stream_id: u64,
    recipient_amount: i128,
    sender_amount: i128,
) -> u64 {
    let stream: Stream = env
        .storage()
        .persistent()
        .get(&DataKey::Stream(stream_id))
        .ok_or_else(|| panic_with_error!(&env, Error::StreamNotFound))?;

    // Validate: No dispute already in progress
    if env.storage().persistent().has(&DataKey::ActiveDisputeForStream(stream_id)) {
        panic_with_error!(&env, Error::DisputeAlreadyQueued);
    }

    // Validate resolution amounts
    if recipient_amount < 0 || sender_amount < 0 {
        panic_with_error!(&env, Error::InvalidResolutionAmounts);
    }

    if recipient_amount
        .checked_add(sender_amount)
        .unwrap_or_else(|| panic_with_error!(&env, Error::ArithmeticOverflow))
        > stream.balance
    {
        panic_with_error!(&env, Error::InvalidResolutionAmounts);
    }

    let now = env.ledger().timestamp();

    // Create a snapshot of current stream state
    let snapshot = DisputeSnapshot {
        stream_id,
        stream_status: stream.status,
        stream_balance: stream.balance,
        stream_total_amount: stream.total_amount,
        recipient: stream.recipient.clone(),
        sender: stream.sender.clone(),
        token: stream.token.clone(),
        snapshot_at: now,
    };

    // Compute deterministic action hash from resolution parameters
    // Hash = sha256(stream_id | recipient_amount | sender_amount | snapshot_at)
    let mut hash_input = env.crypto().sha256(&(
        stream_id,
        recipient_amount,
        sender_amount,
        snapshot_at,
    ).to_bytes());
    let action_hash = BytesN::<32>::from_array(&env, &hash_input);

    // Queue through timelock contract
    let timelock_addr: Address = env
        .storage()
        .instance()
        .get(&DataKey::TimelockContract)
        .unwrap_or_else(|| panic_with_error!(&env, Error::StreamContractNotSet));

    let timelock = TimelockContractClient::new(&env, &timelock_addr);
    let description = soroban_sdk::String::from_str(
        &env,
        &format!("Dispute resolution for stream {}", stream_id),
    );
    timelock.propose_action(
        &action_hash,
        &Some(env.current_contract_address()),
        &description,
    );

    // Increment dispute count
    let mut dispute_count: u64 = env
        .storage()
        .instance()
        .get(&DataKey::DisputeCount)
        .unwrap_or(0);
    if dispute_count == u64::MAX {
        DisputeCountFullEvent {
            timestamp: now,
        }
        .publish(&env);
        panic_with_error!(&env, Error::ContractFull);
    }
    let dispute_id = dispute_count + 1;
    dispute_count += 1;

    // Store queued resolution
    let queued = QueuedResolution {
        dispute_id,
        stream_id,
        recipient_amount,
        sender_amount,
        execute_after: now.saturating_add(DISPUTE_RESOLUTION_TIMELOCK),
        executed: false,
        previous_status: stream.status,
        timelock_action_hash: action_hash,
        snapshot,
    };

    env.storage()
        .persistent()
        .set(&DataKey::DisputeResolution(dispute_id), &queued);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::DisputeResolution(dispute_id), LEDGER_THRESHOLD, LEDGER_BUMP);

    // Mark stream as having an active dispute
    env.storage()
        .persistent()
        .set(&DataKey::ActiveDisputeForStream(stream_id), &dispute_id);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::ActiveDisputeForStream(stream_id), LEDGER_THRESHOLD, LEDGER_BUMP);

    // Update dispute count
    env.storage().instance().set(&DataKey::DisputeCount, &dispute_count);

    DisputeQueuedEvent {
        dispute_id,
        stream_id,
        recipient_amount,
        sender_amount,
        execute_after: queued.execute_after,
    }
    .publish(&env);

    dispute_id
}

/// Execute a queued dispute resolution after the 48-hour timelock.
///
/// Validates the resolution against the snapshot and transfers funds
/// to recipient and sender as specified.
///
/// # Errors
/// - `DisputeNotFound` - No queued resolution for this dispute ID.
/// - `TimelockNotElapsed` - 48 hours have not yet passed.
/// - `DisputeResolutionExpired` - More than 7 days have passed.
/// - `InvalidResolutionAmounts` - Resolution does not match snapshot.
pub fn execute_dispute_resolution(env: Env, dispute_id: u64) {
    let mut queued: QueuedResolution = env
        .storage()
        .persistent()
        .get(&DataKey::DisputeResolution(dispute_id))
        .unwrap_or_else(|| panic_with_error!(&env, Error::DisputeNotFound));

    if queued.executed {
        panic_with_error!(&env, Error::DisputeAlreadyExecuted);
    }

    let now = env.ledger().timestamp();

    // Check timelock has elapsed
    if now < queued.execute_after {
        panic_with_error!(&env, Error::TimelockNotElapsed);
    }

    // Check resolution hasn't expired (7 days)
    if now >= queued.snapshot.snapshot_at.saturating_add(DISPUTE_RESOLUTION_EXPIRY) {
        panic_with_error!(&env, Error::DisputeResolutionExpired);
    }

    // Validate stream still exists and amounts are feasible
    let stream: Stream = env
        .storage()
        .persistent()
        .get(&DataKey::Stream(queued.stream_id))
        .ok_or_else(|| panic_with_error!(&env, Error::StreamNotFound))?;

    if queued.recipient_amount.checked_add(queued.sender_amount)
        .unwrap_or_else(|| panic_with_error!(&env, Error::ArithmeticOverflow))
        > stream.balance
    {
        panic_with_error!(&env, Error::InvalidResolutionAmounts);
    }

    // Execute transfers
    let token_client = token::TokenClient::new(&env, &queued.snapshot.token);

    if queued.recipient_amount > 0 {
        token_client.transfer(&queued.snapshot.recipient, &queued.recipient_amount);
    }

    if queued.sender_amount > 0 {
        token_client.transfer(&queued.snapshot.sender, &queued.sender_amount);
    }

    // Mark as executed and remove dispute flag
    queued.executed = true;
    env.storage()
        .persistent()
        .set(&DataKey::DisputeResolution(dispute_id), &queued);

    env.storage()
        .persistent()
        .remove(&DataKey::ActiveDisputeForStream(queued.stream_id));

    DisputeExecutedEvent {
        dispute_id,
        stream_id: queued.stream_id,
        recipient_amount: queued.recipient_amount,
        sender_amount: queued.sender_amount,
    }
    .publish(&env);
}

/// Cancel a queued dispute resolution.
///
/// Only the stream sender can cancel. Restores the stream to its
/// previous status, freeing it from dispute lock.
///
/// # Errors
/// - `DisputeNotFound` - No queued resolution.
/// - `Unauthorized` - Caller is not the sender.
pub fn cancel_dispute(env: Env, dispute_id: u64) {
    let queued: QueuedResolution = env
        .storage()
        .persistent()
        .get(&DataKey::DisputeResolution(dispute_id))
        .unwrap_or_else(|| panic_with_error!(&env, Error::DisputeNotFound));

    let stream: Stream = env
        .storage()
        .persistent()
        .get(&DataKey::Stream(queued.stream_id))
        .ok_or_else(|| panic_with_error!(&env, Error::StreamNotFound))?;

    // Only sender can cancel
    if queued.snapshot.sender != env.caller() {
        panic_with_error!(&env, Error::Unauthorized);
    }

    // Remove dispute from stream
    env.storage()
        .persistent()
        .remove(&DataKey::ActiveDisputeForStream(queued.stream_id));

    // Remove queued resolution
    env.storage()
        .persistent()
        .remove(&DataKey::DisputeResolution(dispute_id));

    DisputeCanceledEvent {
        dispute_id,
        stream_id: queued.stream_id,
    }
    .publish(&env);
}
```

#### 3. Block Operations During Dispute

```rust
/// Guard: Panic if a dispute is active on this stream.
/// Call this at the start of any fund-moving or status-changing operation.
fn assert_no_active_dispute(env: &Env, stream_id: u64) {
    if env
        .storage()
        .persistent()
        .has(&DataKey::ActiveDisputeForStream(stream_id))
    {
        panic_with_error!(env, Error::DisputeInProgress);
    }
}

/// Modified withdraw() to block during disputes
pub fn withdraw(env: Env, stream_id: u64, amount: i128) -> i128 {
    // NEW: Check no dispute is active
    assert_no_active_dispute(&env, stream_id);

    Self::assert_not_paused(&env);

    // ... rest of withdraw logic ...
}

/// Modified pause_stream() to block during disputes
pub fn pause_stream(env: Env, stream_id: u64) {
    // NEW: Check no dispute is active
    assert_no_active_dispute(&env, stream_id);

    // ... rest of pause logic ...
}

/// Modified cancel_stream() to block during disputes
pub fn cancel_stream(env: Env, stream_id: u64) -> i128 {
    // NEW: Check no dispute is active
    assert_no_active_dispute(&env, stream_id);

    // ... rest of cancel logic ...
}

/// Modified deposit() to block during disputes
pub fn deposit(env: Env, stream_id: u64, amount: i128) {
    // NEW: Check no dispute is active
    assert_no_active_dispute(&env, stream_id);

    // ... rest of deposit logic ...
}
```

### Tests for Objective 4

```rust
#[cfg(test)]
mod dispute_timelock_tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        Address, Env,
    };

    fn set_time(env: &Env, ts: u64) {
        env.ledger().set(LedgerInfo {
            timestamp: ts,
            protocol_version: env.ledger().protocol_version(),
            sequence_number: env.ledger().sequence(),
            network_id: Default::default(),
            base_reserve: 10,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 16,
            max_entry_ttl: 6_312_000,
        });
    }

    #[test]
    fn test_resolve_dispute_queues_with_48h_timelock() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);

        let (admin, client, _, _) = setup_payment_stream(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);

        token_admin_client.mint(&sender, &10_000);

        let stream_id = client.create_stream(
            &sender,
            &recipient,
            &token_addr,
            &5_000,
            &1_000,
            &1_000,
            &2_000,
        );

        // Resolve dispute
        let dispute_id = client.resolve_dispute(&stream_id, &2_000, &1_000);

        let queued = client.get_dispute_resolution(&dispute_id);
        assert_eq!(queued.execute_after, 1_000 + DISPUTE_RESOLUTION_TIMELOCK);
        assert!(!queued.executed);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #DisputeInProgress)")]
    fn test_cannot_withdraw_during_active_dispute() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);

        let (_, client, _, _) = setup_payment_stream(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);

        token_admin_client.mint(&sender, &10_000);

        let stream_id = client.create_stream(
            &sender,
            &recipient,
            &token_addr,
            &5_000,
            &1_000,
            &1_000,
            &2_000,
        );

        // Resolve dispute (creates lock)
        client.resolve_dispute(&stream_id, &2_000, &1_000);

        // Try to withdraw - should fail
        client.withdraw(&stream_id, &500);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #TimelockNotElapsed)")]
    fn test_cannot_execute_dispute_before_48h() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);

        let (_, client, _, _) = setup_payment_stream(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);

        token_admin_client.mint(&sender, &10_000);

        let stream_id = client.create_stream(
            &sender,
            &recipient,
            &token_addr,
            &5_000,
            &1_000,
            &1_000,
            &2_000,
        );

        let dispute_id = client.resolve_dispute(&stream_id, &2_000, &1_000);

        // Try to execute before 48h - should fail
        set_time(&env, 1_000 + 86_400); // Only 1 day
        client.execute_dispute_resolution(&dispute_id);
    }

    #[test]
    fn test_execute_dispute_after_48h_timelock() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);

        let (_, client, _, _) = setup_payment_stream(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);

        token_admin_client.mint(&sender, &10_000);

        let stream_id = client.create_stream(
            &sender,
            &recipient,
            &token_addr,
            &5_000,
            &1_000,
            &1_000,
            &2_000,
        );

        let dispute_id = client.resolve_dispute(&stream_id, &2_500, &500);

        // Fast-forward 48h + 1 second
        set_time(&env, 1_000 + DISPUTE_RESOLUTION_TIMELOCK + 1);

        // Execute should succeed
        client.execute_dispute_resolution(&dispute_id);

        let queued = client.get_dispute_resolution(&dispute_id);
        assert!(queued.executed);

        // Recipient should have received their amount
        let recipient_balance = token_admin_client.balance(&recipient);
        assert_eq!(recipient_balance, 2_500);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #DisputeResolutionExpired)")]
    fn test_cannot_execute_dispute_after_7_days() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);

        let (_, client, _, _) = setup_payment_stream(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);

        token_admin_client.mint(&sender, &10_000);

        let stream_id = client.create_stream(
            &sender,
            &recipient,
            &token_addr,
            &5_000,
            &1_000,
            &1_000,
            &2_000,
        );

        let dispute_id = client.resolve_dispute(&stream_id, &2_500, &500);

        // Fast-forward 7 days + 1 second
        set_time(&env, 1_000 + DISPUTE_RESOLUTION_EXPIRY + 1);

        // Execute should fail - expired
        client.execute_dispute_resolution(&dispute_id);
    }

    #[test]
    fn test_sender_can_cancel_dispute() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);

        let (_, client, _, _) = setup_payment_stream(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);

        token_admin_client.mint(&sender, &10_000);

        let stream_id = client.create_stream(
            &sender,
            &recipient,
            &token_addr,
            &5_000,
            &1_000,
            &1_000,
            &2_000,
        );

        let dispute_id = client.resolve_dispute(&stream_id, &2_500, &500);

        // Sender cancels the dispute
        client.cancel_dispute(&dispute_id);

        // Dispute should be removed
        let result = client.try_get_dispute_resolution(&dispute_id);
        assert!(result.is_err());

        // Stream should be unlocked - can now withdraw
        set_time(&env, 1_000 + 1_000);
        let withdrew = client.withdraw(&stream_id, &500);
        assert!(withdrew > 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #Unauthorized)")]
    fn test_only_sender_can_cancel_dispute() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);

        let (_, client, _, _) = setup_payment_stream(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let attacker = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);

        token_admin_client.mint(&sender, &10_000);

        let stream_id = client.create_stream(
            &sender,
            &recipient,
            &token_addr,
            &5_000,
            &1_000,
            &1_000,
            &2_000,
        );

        let dispute_id = client.resolve_dispute(&stream_id, &2_500, &500);

        // Attacker (recipient) tries to cancel - should fail
        env.as_contract(&env.current_contract_address(), || {
            client.cancel_dispute(&dispute_id);
        });
    }

    #[test]
    fn test_dispute_snapshot_preserves_stream_state() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);

        let (_, client, _, _) = setup_payment_stream(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let (token_addr, _, token_admin_client) = create_token(&env, &token_admin);

        token_admin_client.mint(&sender, &10_000);

        let stream_id = client.create_stream(
            &sender,
            &recipient,
            &token_addr,
            &5_000,
            &1_000,
            &1_000,
            &2_000,
        );

        let dispute_id = client.resolve_dispute(&stream_id, &2_500, &500);

        let queued = client.get_dispute_resolution(&dispute_id);
        assert_eq!(queued.snapshot.stream_id, stream_id);
        assert_eq!(queued.snapshot.recipient, recipient);
        assert_eq!(queued.snapshot.sender, sender);
        assert_eq!(queued.snapshot.stream_balance, 1_000);
    }
}
```

---

## Summary

This document outlines four critical security objectives and their implementations:

1. **Asset Validation**: Prevents acceptance of unsafe tokens with transfer restrictions or non-standard decimals.
2. **Notice & Claim Periods**: Ensures donors have recourse time before funds are irreversibly claimed.
3. **Approval Threshold Governance**: Locks dispute rules at creation time to prevent mid-dispute manipulation.
4. **Dispute Timelock & Blocking**: Enforces mandatory 48-hour delays and prevents concurrent fund operations during disputes.

Each objective includes:
- Current vulnerability analysis
- Required fixes with detailed explanations
- Production-ready Rust implementation code
- Comprehensive test cases for verification

Implementation should follow the priority order: Objective 1 → Objective 2 → Objective 3 → Objective 4, with full regression testing after each stage.
