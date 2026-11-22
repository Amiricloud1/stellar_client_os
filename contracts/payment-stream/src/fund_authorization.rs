/// Fund authorization boundaries and governance for protocol-owned funds
///
/// This module enforces:
/// 1. Separation of protocol-owned funds from user escrow
/// 2. Purpose-based fund allocation (e.g., reserves, incentives, fees)
/// 3. Spending limits per purpose and per recipient
/// 4. Authorization requirements for fund disbursement
///
/// Satisfies: Objective 3 - Bound recipients, purposes, limits, authorization

use soroban_sdk::{contracttype, Address, Env, Vec};

/// Purpose categories for protocol-owned fund allocations
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FundPurpose {
    /// Reserve funds for protocol stability (e.g., insurance)
    Reserve,
    /// Incentive funds distributed to users (e.g., early adopter rewards)
    Incentive,
    /// Protocol revenue (collected fees)
    Revenue,
    /// Development fund for contract upgrades
    Development,
    /// Emergency fund for unforeseen issues
    Emergency,
}

impl FundPurpose {
    /// Convert purpose to stable storage key
    pub fn to_key(&self) -> Vec<u8> {
        match self {
            Self::Reserve => soroban_sdk::bytes!(b"reserve").to_vec(),
            Self::Incentive => soroban_sdk::bytes!(b"incentive").to_vec(),
            Self::Revenue => soroban_sdk::bytes!(b"revenue").to_vec(),
            Self::Development => soroban_sdk::bytes!(b"development").to_vec(),
            Self::Emergency => soroban_sdk::bytes!(b"emergency").to_vec(),
        }
    }
}

/// Authorization levels for fund disbursement
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthorizationLevel {
    /// Single signature required (admin)
    Single,
    /// Multiple signatures required (multi-sig)
    MultiSig,
    /// DAO voting required
    Governance,
}

/// Spending limit for a fund allocation
#[contracttype]
#[derive(Clone)]
pub struct SpendingLimit {
    /// Maximum amount that can be disbursed in one transaction
    pub per_transaction_limit: i128,
    /// Maximum amount that can be disbursed per day
    pub per_day_limit: i128,
    /// Maximum amount total that can be disbursed from this allocation
    pub total_limit: i128,
    /// Amount already spent/allocated
    pub amount_spent: i128,
    /// Amount spent in current day
    pub amount_spent_today: i128,
    /// Timestamp of last day reset
    pub last_day_reset: u64,
}

impl SpendingLimit {
    /// Check if a proposed spend is within limits
    pub fn can_spend(&self, amount: i128, current_time: u64) -> bool {
        // Check total limit
        if self.amount_spent + amount > self.total_limit {
            return false;
        }

        // Check daily limit (reset if day has passed)
        let days_since_reset = (current_time - self.last_day_reset) / 86400;
        let day_amount = if days_since_reset > 0 {
            amount // First spend of new day
        } else {
            self.amount_spent_today + amount
        };

        if day_amount > self.per_day_limit {
            return false;
        }

        // Check per-transaction limit
        if amount > self.per_transaction_limit {
            return false;
        }

        true
    }

    /// Apply a spend against the limit
    pub fn apply_spend(&mut self, amount: i128, current_time: u64) {
        self.amount_spent += amount;

        let days_since_reset = (current_time - self.last_day_reset) / 86400;
        if days_since_reset > 0 {
            // Reset daily counter and update timestamp
            self.amount_spent_today = amount;
            self.last_day_reset = current_time;
        } else {
            // Continue adding to current day
            self.amount_spent_today += amount;
        }
    }
}

/// Authorization policy for a fund purpose
#[contracttype]
#[derive(Clone)]
pub struct FundAuthorizationPolicy {
    /// Purpose of the fund
    pub purpose: FundPurpose,
    /// Required authorization level
    pub auth_level: AuthorizationLevel,
    /// Addresses authorized to approve disbursements
    pub approvers: Vec<Address>,
    /// Spending limits
    pub spending_limits: SpendingLimit,
    /// Allowed recipients (empty = no restriction)
    pub allowed_recipients: Vec<Address>,
    /// true if policy is currently active
    pub active: bool,
}

impl FundAuthorizationPolicy {
    /// Check if a disbursement request is authorized
    pub fn can_disburse(
        &self,
        amount: i128,
        recipient: &Address,
        approvers_provided: Vec<Address>,
        current_time: u64,
    ) -> bool {
        // Check if policy is active
        if !self.active {
            return false;
        }

        // Check if recipient is allowed
        if !self.allowed_recipients.is_empty() {
            let mut found = false;
            for allowed in &self.allowed_recipients {
                if allowed == recipient {
                    found = true;
                    break;
                }
            }
            if !found {
                return false;
            }
        }

        // Check spending limits
        if !self.spending_limits.can_spend(amount, current_time) {
            return false;
        }

        // Check authorization level
        match self.auth_level {
            AuthorizationLevel::Single => {
                // Single approver must be in list
                if approvers_provided.len() != 1 {
                    return false;
                }
                self.approvers.contains(&approvers_provided[0])
            }
            AuthorizationLevel::MultiSig => {
                // At least 2 approvers required
                if approvers_provided.len() < 2 {
                    return false;
                }
                // All provided approvers must be in authorized list
                for approver in &approvers_provided {
                    if !self.approvers.contains(approver) {
                        return false;
                    }
                }
                true
            }
            AuthorizationLevel::Governance => {
                // Would require voting on-chain or off-chain proof
                // For now, require consensus from all approvers
                if approvers_provided.len() != self.approvers.len() {
                    return false;
                }
                for approver in &approvers_provided {
                    if !self.approvers.contains(approver) {
                        return false;
                    }
                }
                true
            }
        }
    }
}

/// Storage key for fund tracking
#[contracttype]
#[derive(Clone)]
pub enum FundKey {
    /// Balance of protocol-owned funds by purpose
    Balance(FundPurpose),
    /// Authorization policy for a fund purpose
    Policy(FundPurpose),
    /// Disbursement history (for audit trail)
    DisbursementHistory(u64), // sequence number
}

/// Audit event for fund disbursement
#[contracttype]
#[derive(Clone)]
pub struct FundDisbursementEvent {
    /// Purpose of the fund being disbursed
    pub purpose: FundPurpose,
    /// Amount disbursed (in token native units)
    pub amount: i128,
    /// Recipient of disbursement
    pub recipient: Address,
    /// Addresses who approved this disbursement
    pub approvers: Vec<Address>,
    /// Authorization level required
    pub auth_level: AuthorizationLevel,
    /// Timestamp of disbursement
    pub timestamp: u64,
}

/// Initialize fund authorization with default policies
pub fn initialize_fund_authorization(env: &Env, admin: &Address) {
    // Create default policies for each purpose
    let purposes = [
        FundPurpose::Reserve,
        FundPurpose::Incentive,
        FundPurpose::Revenue,
        FundPurpose::Development,
        FundPurpose::Emergency,
    ];

    let mut approvers = Vec::new(env);
    approvers.push_back(admin.clone());

    for purpose in &purposes {
        let policy = FundAuthorizationPolicy {
            purpose: *purpose,
            auth_level: match purpose {
                FundPurpose::Emergency => AuthorizationLevel::MultiSig, // Emergency is highest
                FundPurpose::Development => AuthorizationLevel::MultiSig, // Development requires approval
                _ => AuthorizationLevel::Single, // Others require single approval
            },
            approvers: approvers.clone(),
            spending_limits: SpendingLimit {
                per_transaction_limit: 1_000_000_000, // 1B units (adjustable)
                per_day_limit: 5_000_000_000,         // 5B units per day
                total_limit: 1_000_000_000_000,       // 1T units total
                amount_spent: 0,
                amount_spent_today: 0,
                last_day_reset: env.ledger().timestamp(),
            },
            allowed_recipients: Vec::new(env), // No restriction initially
            active: true,
        };

        let key = FundKey::Policy(*purpose);
        env.storage().instance().set(&key, &policy);

        // Initialize balance to 0
        let balance_key = FundKey::Balance(*purpose);
        env.storage().instance().set(&balance_key, &0i128);
    }
}

/// Deposit funds into a protocol-owned fund (separate from user escrow)
pub fn deposit_to_fund(env: &Env, purpose: FundPurpose, amount: i128) -> i128 {
    let key = FundKey::Balance(purpose);
    let current_balance: i128 = env
        .storage()
        .instance()
        .get(&key)
        .unwrap_or(Ok(0))
        .unwrap_or(0);

    let new_balance = current_balance + amount;
    env.storage().instance().set(&key, &new_balance);

    new_balance
}

/// Withdraw funds from a protocol-owned fund with authorization checks
pub fn withdraw_from_fund(
    env: &Env,
    purpose: FundPurpose,
    amount: i128,
    recipient: &Address,
    approvers: Vec<Address>,
) -> Result<i128, &'static str> {
    // Load policy
    let policy_key = FundKey::Policy(purpose);
    let mut policy: FundAuthorizationPolicy = env
        .storage()
        .instance()
        .get(&policy_key)
        .map_err(|_| "Policy not found")?
        .map_err(|_| "Policy retrieval failed")?;

    // Check authorization
    if !policy.can_disburse(amount, recipient, approvers.clone(), env.ledger().timestamp()) {
        return Err("Disbursement not authorized");
    }

    // Check balance
    let balance_key = FundKey::Balance(purpose);
    let current_balance: i128 = env
        .storage()
        .instance()
        .get(&balance_key)
        .unwrap_or(Ok(0))
        .unwrap_or(0);

    if current_balance < amount {
        return Err("Insufficient fund balance");
    }

    // Apply spend against limits
    policy.spending_limits.apply_spend(amount, env.ledger().timestamp());
    env.storage().instance().set(&policy_key, &policy);

    // Reduce balance
    let new_balance = current_balance - amount;
    env.storage().instance().set(&balance_key, &new_balance);

    // Emit audit event
    env.events().publish(
        ("FundDisbursement",),
        FundDisbursementEvent {
            purpose,
            amount,
            recipient: recipient.clone(),
            approvers,
            auth_level: policy.auth_level,
            timestamp: env.ledger().timestamp(),
        },
    );

    Ok(new_balance)
}

/// Query the balance of a fund
pub fn get_fund_balance(env: &Env, purpose: FundPurpose) -> i128 {
    let key = FundKey::Balance(purpose);
    env.storage()
        .instance()
        .get(&key)
        .unwrap_or(Ok(0))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spending_limit_enforcement() {
        let mut limit = SpendingLimit {
            per_transaction_limit: 100,
            per_day_limit: 500,
            total_limit: 1000,
            amount_spent: 0,
            amount_spent_today: 0,
            last_day_reset: 1000,
        };

        // Should allow spend within limits
        assert!(limit.can_spend(50, 1000));
        assert!(limit.can_spend(100, 1000));

        // Should reject spend exceeding per-transaction limit
        assert!(!limit.can_spend(150, 1000));

        // Apply a spend
        limit.apply_spend(50, 1000);
        assert_eq!(limit.amount_spent_today, 50);

        // Should enforce daily limit
        assert!(!limit.can_spend(500, 1000)); // Would exceed daily limit
        assert!(limit.can_spend(450, 1000));
    }

    #[test]
    fn test_authorization_policy_single_sig() {
        let env = Env::new();
        let admin = Address::random(&env);
        let approver = Address::random(&env);
        let recipient = Address::random(&env);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver.clone());

        let policy = FundAuthorizationPolicy {
            purpose: FundPurpose::Revenue,
            auth_level: AuthorizationLevel::Single,
            approvers,
            spending_limits: SpendingLimit {
                per_transaction_limit: 1000,
                per_day_limit: 5000,
                total_limit: 10000,
                amount_spent: 0,
                amount_spent_today: 0,
                last_day_reset: 0,
            },
            allowed_recipients: Vec::new(&env),
            active: true,
        };

        let mut approvers_provided = Vec::new(&env);
        approvers_provided.push_back(approver);

        assert!(policy.can_disburse(100, &recipient, approvers_provided, 0));
    }

    #[test]
    fn test_fund_purpose_keys() {
        let purposes = [
            FundPurpose::Reserve,
            FundPurpose::Incentive,
            FundPurpose::Revenue,
            FundPurpose::Development,
            FundPurpose::Emergency,
        ];

        for purpose in &purposes {
            let key = purpose.to_key();
            assert!(!key.is_empty());
        }
    }
}
