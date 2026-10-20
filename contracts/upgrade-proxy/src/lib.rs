#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, BytesN,
    Env,
};

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The admin address authorized to approve and execute upgrades.
    Admin,
    /// The current implementation WASM hash stored on-chain.
    ImplementationHash,
    /// Pending upgrade: stores (new_hash, approval_timestamp).
    PendingUpgrade,
    /// Historical previous implementation hash for emergency rollback.
    PreviousImplementationHash,
    /// Storage schema version.
    SchemaVersion,
}

/// Core state of the proxy contract.
#[contracttype]
#[derive(Clone)]
pub struct UpgradeProposal {
    /// WASM hash of the proposed new implementation.
    pub new_hash: BytesN<32>,
    /// Ledger timestamp when the upgrade was approved.
    pub approved_at: u64,
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    NoPendingUpgrade = 4,
    TimelockNotElapsed = 5,
    InvalidImplementationHash = 6,
    UpgradeAlreadyPending = 7,
    NoPreviousImplementation = 8,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Current storage schema version
pub const SCHEMA_VERSION: u32 = 2;

/// 48 hours in seconds (48 * 60 * 60 = 172800).
const TIMELOCK_SECONDS: u64 = 172_800;

/// Storage TTL threshold: ~30 days at 5 s/ledger.
const LEDGER_THRESHOLD: u32 = 518_400;
/// Storage TTL bump: ~31 days at 5 s/ledger.
const LEDGER_BUMP: u32 = 535_680;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct UpgradeProxyContract;

#[contractimpl]
impl UpgradeProxyContract {
    // -----------------------------------------------------------------------
    // Initialisation
    // -----------------------------------------------------------------------

    /// Initialize the proxy contract.
    ///
    /// Sets the admin and the initial implementation hash.
    ///
    /// # Arguments
    /// * `admin`              — Address authorized to approve upgrades.
    /// * `implementation_hash` — WASM hash of the initial implementation.
    pub fn initialize(env: Env, admin: Address, implementation_hash: BytesN<32>) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::ImplementationHash, &implementation_hash);
        env.storage()
            .instance()
            .set(&DataKey::SchemaVersion, &SCHEMA_VERSION);
        env.storage().instance().extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);
    }

    // -----------------------------------------------------------------------
    // Upgrade lifecycle
    // -----------------------------------------------------------------------

    /// Approve a new implementation hash and start the 48h timelock.
    ///
    /// Only the admin can call this. Validates the proposed implementation hash,
    /// verifies no upgrade is already pending, and records the proposal.
    ///
    /// # Arguments
    /// * `new_hash` — WASM hash of the proposed new implementation.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — caller is not the admin.
    /// * [`Error::NotInitialized`] — contract not initialized.
    /// * [`Error::UpgradeAlreadyPending`] — a proposal is already pending.
    /// * [`Error::InvalidImplementationHash`] — hash is empty or identical to current.
    pub fn approve_upgrade(env: Env, new_hash: BytesN<32>) {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();

        if env.storage().instance().has(&DataKey::PendingUpgrade) {
            panic_with_error!(&env, Error::UpgradeAlreadyPending);
        }

        let current_hash = Self::get_implementation_hash(env.clone());
        if new_hash == current_hash {
            panic_with_error!(&env, Error::InvalidImplementationHash);
        }

        let proposal = UpgradeProposal {
            new_hash: new_hash.clone(),
            approved_at: env.ledger().timestamp(),
        };

        env.storage()
            .instance()
            .set(&DataKey::PendingUpgrade, &proposal);
        env.storage().instance().extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);

        env.events()
            .publish(("UpgradeApproved",), (admin, new_hash));
    }

    /// Execute a previously approved upgrade after the 48h timelock.
    ///
    /// Updates the stored implementation hash, retains the prior hash for
    /// emergency rollback, and clears the pending upgrade.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — caller is not the admin.
    /// * [`Error::NoPendingUpgrade`] — no upgrade has been approved.
    /// * [`Error::TimelockNotElapsed`] — less than 48h since approval.
    pub fn execute_upgrade(env: Env) {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();

        let proposal: UpgradeProposal = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NoPendingUpgrade));

        let elapsed = env
            .ledger()
            .timestamp()
            .checked_sub(proposal.approved_at)
            .unwrap_or(0);

        if elapsed < TIMELOCK_SECONDS {
            panic_with_error!(&env, Error::TimelockNotElapsed);
        }

        // Save current hash as previous before updating
        let current_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::ImplementationHash)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        env.storage()
            .instance()
            .set(&DataKey::PreviousImplementationHash, &current_hash);

        // Update implementation hash.
        env.storage().instance().set(
            &DataKey::ImplementationHash,
            &proposal.new_hash,
        );

        // Clear pending upgrade.
        env.storage().instance().remove(&DataKey::PendingUpgrade);
        env.storage().instance().extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);

        env.events()
            .publish(("UpgradeExecuted",), (admin, proposal.new_hash));
    }

    /// Cancel a pending upgrade before execution.
    ///
    /// Only the admin can call this.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — caller is not the admin.
    /// * [`Error::NoPendingUpgrade`] — no upgrade is pending.
    pub fn cancel_upgrade(env: Env) {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();

        if !env
            .storage()
            .instance()
            .has(&DataKey::PendingUpgrade)
        {
            panic_with_error!(&env, Error::NoPendingUpgrade);
        }

        env.storage().instance().remove(&DataKey::PendingUpgrade);
        env.storage().instance().extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);

        env.events().publish(("UpgradeCancelled",), (admin,));
    }

    // -----------------------------------------------------------------------
    // Recovery & Rollback
    // -----------------------------------------------------------------------

    /// Roll back to the previous implementation hash in case of an emergency.
    ///
    /// Only the admin can call this. Clears any pending upgrade.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — caller is not the admin.
    /// * [`Error::NoPreviousImplementation`] — no previous implementation exists.
    pub fn emergency_rollback(env: Env) {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();

        let prev_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::PreviousImplementationHash)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NoPreviousImplementation));

        let current_hash = Self::get_implementation_hash(env.clone());

        env.storage()
            .instance()
            .set(&DataKey::ImplementationHash, &prev_hash);
        env.storage()
            .instance()
            .set(&DataKey::PreviousImplementationHash, &current_hash);
        env.storage().instance().remove(&DataKey::PendingUpgrade);
        env.storage().instance().extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);

        env.events()
            .publish(("UpgradeRolledBack",), (admin, prev_hash));
    }

    /// Emergency recovery method allowing the admin to force-update implementation.
    ///
    /// Used when a deployed implementation is corrupted or halting contract execution.
    ///
    /// # Arguments
    /// * `fallback_hash` — WASM hash of the validated fallback implementation.
    pub fn emergency_recovery(env: Env, fallback_hash: BytesN<32>) {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();

        let current_hash = Self::get_implementation_hash(env.clone());
        if fallback_hash == current_hash {
            panic_with_error!(&env, Error::InvalidImplementationHash);
        }

        env.storage()
            .instance()
            .set(&DataKey::PreviousImplementationHash, &current_hash);
        env.storage()
            .instance()
            .set(&DataKey::ImplementationHash, &fallback_hash);
        env.storage().instance().remove(&DataKey::PendingUpgrade);
        env.storage().instance().extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);

        env.events()
            .publish(("EmergencyRecovery",), (admin, fallback_hash));
    }

    // -----------------------------------------------------------------------
    // Queries
    // -----------------------------------------------------------------------

    /// Return the current implementation hash.
    pub fn get_implementation_hash(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::ImplementationHash)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    /// Return the previous implementation hash, if any.
    pub fn get_previous_implementation_hash(env: Env) -> Option<BytesN<32>> {
        env.storage()
            .instance()
            .get(&DataKey::PreviousImplementationHash)
    }

    /// Return the admin address.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    /// Return the pending upgrade proposal, if any.
    pub fn get_pending_upgrade(env: Env) -> Option<UpgradeProposal> {
        env.storage().instance().get(&DataKey::PendingUpgrade)
    }

    /// Return the current schema version of the contract.
    pub fn get_schema_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::SchemaVersion)
            .unwrap_or(1)
    }

    /// Check whether a pending upgrade has passed the 48h timelock.
    pub fn is_upgrade_ready(env: Env) -> bool {
        let proposal: UpgradeProposal = match env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
        {
            Some(p) => p,
            None => return false,
        };

        let elapsed = env
            .ledger()
            .timestamp()
            .checked_sub(proposal.approved_at)
            .unwrap_or(0);

        elapsed >= TIMELOCK_SECONDS
    }

    // -----------------------------------------------------------------------
    // Admin setters & Migrations
    // -----------------------------------------------------------------------

    /// Update the admin address.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — caller is not the current admin.
    pub fn set_admin(env: Env, new_admin: Address) {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);
    }

    /// Perform idempotent schema migration.
    ///
    /// Upgrades legacy storage layouts to the current schema version.
    pub fn migrate_schema(env: Env) -> u32 {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();

        let current_version = Self::get_schema_version(env.clone());
        if current_version < SCHEMA_VERSION {
            env.storage()
                .instance()
                .set(&DataKey::SchemaVersion, &SCHEMA_VERSION);
            env.storage().instance().extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);
            env.events()
                .publish(("SchemaMigrated",), (admin, current_version, SCHEMA_VERSION));
        }

        SCHEMA_VERSION
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
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

    fn setup_contract(env: &Env) -> (Address, UpgradeProxyContractClient) {
        let contract_id = env.register(UpgradeProxyContract, ());
        let client = UpgradeProxyContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let hash = BytesN::from_array(env, &[0u8; 32]);
        client.initialize(&admin, &hash);
        (admin, client)
    }

    #[test]
    fn test_initialize_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup_contract(&env);
        assert_eq!(client.get_admin(), admin);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_initialize_twice_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup_contract(&env);
        let hash = BytesN::from_array(&env, &[0u8; 32]);
        client.initialize(&admin, &hash);
    }

    #[test]
    fn test_approve_and_execute_upgrade() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client) = setup_contract(&env);

        let new_hash = BytesN::from_array(&env, &[1u8; 32]);
        client.approve_upgrade(&new_hash);

        let proposal = client.get_pending_upgrade().unwrap();
        assert_eq!(proposal.approved_at, 1_000);

        // Cannot execute before 48h.
        set_time(&env, 1_000 + 100_000);
        assert!(!client.is_upgrade_ready());

        // Execute after 48h.
        set_time(&env, 1_000 + TIMELOCK_SECONDS);
        client.execute_upgrade();

        assert_eq!(client.get_implementation_hash(), new_hash);
        assert!(client.get_pending_upgrade().is_none());
    }

    #[test]
    fn test_cancel_upgrade() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client) = setup_contract(&env);

        let new_hash = BytesN::from_array(&env, &[1u8; 32]);
        client.approve_upgrade(&new_hash);
        assert!(client.get_pending_upgrade().is_some());

        client.cancel_upgrade();
        assert!(client.get_pending_upgrade().is_none());
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_execute_before_timelock_fails() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client) = setup_contract(&env);

        let new_hash = BytesN::from_array(&env, &[1u8; 32]);
        client.approve_upgrade(&new_hash);

        // Try to execute immediately.
        client.execute_upgrade();
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_execute_no_pending_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client) = setup_contract(&env);
        client.execute_upgrade();
    }

    #[test]
    fn test_set_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let (old_admin, client) = setup_contract(&env);

        let new_admin = Address::generate(&env);
        client.set_admin(&new_admin);

        assert_eq!(client.get_admin(), new_admin);
        assert_ne!(client.get_admin(), old_admin);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn test_approve_same_hash_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client) = setup_contract(&env);

        // Current hash is &[0u8; 32] from setup_contract
        let same_hash = BytesN::from_array(&env, &[0u8; 32]);
        client.approve_upgrade(&same_hash);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")]
    fn test_approve_when_already_pending_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client) = setup_contract(&env);

        let hash1 = BytesN::from_array(&env, &[1u8; 32]);
        client.approve_upgrade(&hash1);

        let hash2 = BytesN::from_array(&env, &[2u8; 32]);
        client.approve_upgrade(&hash2);
    }

    #[test]
    fn test_emergency_rollback_and_recovery() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (_, client) = setup_contract(&env);

        let initial_hash = BytesN::from_array(&env, &[0u8; 32]);
        let hash1 = BytesN::from_array(&env, &[1u8; 32]);
        client.approve_upgrade(&hash1);

        set_time(&env, 1_000 + TIMELOCK_SECONDS);
        client.execute_upgrade();
        assert_eq!(client.get_implementation_hash(), hash1);
        assert_eq!(client.get_previous_implementation_hash(), Some(initial_hash.clone()));

        // Perform emergency rollback
        client.emergency_rollback();
        assert_eq!(client.get_implementation_hash(), initial_hash);
        assert_eq!(client.get_previous_implementation_hash(), Some(hash1.clone()));

        // Perform emergency recovery to arbitrary validated hash
        let recovery_hash = BytesN::from_array(&env, &[9u8; 32]);
        client.emergency_recovery(&recovery_hash);
        assert_eq!(client.get_implementation_hash(), recovery_hash);
        assert_eq!(client.get_previous_implementation_hash(), Some(initial_hash));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_emergency_rollback_without_history_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client) = setup_contract(&env);
        client.emergency_rollback();
    }

    #[test]
    fn test_schema_migration_idempotent() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client) = setup_contract(&env);

        assert_eq!(client.get_schema_version(), SCHEMA_VERSION);
        let version = client.migrate_schema();
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(client.get_schema_version(), SCHEMA_VERSION);
    }
}


