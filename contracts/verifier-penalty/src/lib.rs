#![no_std]

//! Verifier staking and bounded penalties.
//!
//! Every penalty must reference a known offense ID and a unique evidence
//! hash. Each offense carries a maximum penalty expressed in basis points of
//! the verifier's stake at report time, so repeated or replayed evidence can
//! never compound losses unexpectedly. Penalised verifiers may appeal once;
//! the admin either upholds the penalty or reverses it, restoring the stake.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
};

/// Basis-point denominator (100 %).
pub const BPS_DENOMINATOR: i128 = 10_000;

/// Offense: verifier approved a tree that was dead or never planted.
pub const OFFENSE_APPROVED_DEAD_TREE: u32 = 1;
/// Offense: verifier submitted falsified or tampered evidence.
pub const OFFENSE_FALSIFIED_EVIDENCE: u32 = 2;
/// Offense: verifier missed the verification SLA window.
pub const OFFENSE_MISSED_SLA: u32 = 3;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Caller is not the admin, or the contract has no admin yet.
    NotAdmin = 1,
    /// Requested penalty exceeds the verifier's current stake.
    InsufficientStake = 2,
    /// Verifier has no stake.
    NotStaked = 3,
    /// `initialize` was called twice.
    AlreadyInitialized = 4,
    /// Amount must be strictly positive.
    InvalidAmount = 5,
    /// Requested penalty exceeds the offense's maximum.
    PenaltyExceedsMax = 6,
    /// The evidence hash was already used by a previous report.
    DuplicateEvidence = 7,
    /// The referenced penalty report does not exist.
    ReportNotFound = 8,
    /// The report has already been appealed or resolved.
    AlreadyAppealed = 9,
    /// The report is not awaiting an appeal decision.
    AppealNotPending = 10,
    /// Unknown offense identifier.
    InvalidOffense = 11,
    /// Only the penalised verifier may appeal a report.
    NotReportedVerifier = 12,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReportStatus {
    /// Penalty applied; appeal still possible.
    Applied,
    /// Verifier appealed; awaiting admin decision.
    Appealed,
    /// Admin upheld the penalty after appeal (final).
    Upheld,
    /// Admin reversed the penalty and restored the stake (final).
    Reversed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PenaltyReport {
    pub id: u64,
    pub verifier: Address,
    pub offense_id: u32,
    /// Hash of the off-chain evidence bundle. Raw evidence is never stored.
    pub evidence_hash: BytesN<32>,
    pub amount: i128,
    pub status: ReportStatus,
    pub reported_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Stake(Address),
    ReportCount,
    Report(u64),
    Evidence(BytesN<32>),
}

#[contract]
pub struct VerifierPenaltyContract;

#[contractimpl]
impl VerifierPenaltyContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// Verifier stakes a bond to become eligible for verifying trees.
    pub fn stake(env: Env, verifier: Address, amount: i128) -> Result<(), Error> {
        verifier.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let current = Self::get_stake(env.clone(), verifier.clone());
        let new_stake = current.checked_add(amount).ok_or(Error::InvalidAmount)?;
        env.storage()
            .persistent()
            .set(&DataKey::Stake(verifier.clone()), &new_stake);
        env.events().publish((symbol_short!("staked"), verifier), amount);
        Ok(())
    }

    /// Maximum penalty for an offense, in basis points of the current stake.
    pub fn max_penalty_bps(offense_id: u32) -> Result<i128, Error> {
        match offense_id {
            OFFENSE_APPROVED_DEAD_TREE => Ok(2_000),
            OFFENSE_FALSIFIED_EVIDENCE => Ok(5_000),
            OFFENSE_MISSED_SLA => Ok(500),
            _ => Err(Error::InvalidOffense),
        }
    }

    /// Admin reports an offense and applies a bounded penalty.
    ///
    /// Rejects unknown offenses, non-positive amounts, amounts above the
    /// offense cap (rounded down), and evidence hashes already used.
    pub fn report_offense(
        env: Env,
        verifier: Address,
        offense_id: u32,
        evidence_hash: BytesN<32>,
        amount: i128,
    ) -> Result<u64, Error> {
        let admin = Self::get_admin(&env)?;
        admin.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let max_bps = Self::max_penalty_bps(offense_id)?;

        let evidence_key = DataKey::Evidence(evidence_hash.clone());
        if env.storage().persistent().has(&evidence_key) {
            return Err(Error::DuplicateEvidence);
        }

        let stake = Self::get_stake(env.clone(), verifier.clone());
        if stake <= 0 {
            return Err(Error::NotStaked);
        }
        if amount > stake {
            return Err(Error::InsufficientStake);
        }
        // Floor rounding: the cap never exceeds the exact bps share.
        let cap = stake * max_bps / BPS_DENOMINATOR;
        if amount > cap {
            return Err(Error::PenaltyExceedsMax);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ReportCount)
            .unwrap_or(0u64)
            + 1;

        let report = PenaltyReport {
            id,
            verifier: verifier.clone(),
            offense_id,
            evidence_hash: evidence_hash.clone(),
            amount,
            status: ReportStatus::Applied,
            reported_at: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Stake(verifier.clone()), &(stake - amount));
        env.storage().persistent().set(&DataKey::Report(id), &report);
        env.storage().persistent().set(&evidence_key, &id);
        env.storage().instance().set(&DataKey::ReportCount, &id);

        env.events()
            .publish((symbol_short!("slashed"), verifier), (id, offense_id, amount));
        Ok(id)
    }

    /// The penalised verifier appeals a report. Allowed once per report.
    pub fn appeal(env: Env, verifier: Address, report_id: u64) -> Result<(), Error> {
        verifier.require_auth();
        let mut report = Self::get_report(env.clone(), report_id)?;
        if report.verifier != verifier {
            return Err(Error::NotReportedVerifier);
        }
        if report.status != ReportStatus::Applied {
            return Err(Error::AlreadyAppealed);
        }
        report.status = ReportStatus::Appealed;
        env.storage()
            .persistent()
            .set(&DataKey::Report(report_id), &report);
        env.events()
            .publish((symbol_short!("appealed"), verifier), report_id);
        Ok(())
    }

    /// Admin resolves a pending appeal. Reversal restores the penalised
    /// amount to the verifier's stake exactly once.
    pub fn resolve_appeal(env: Env, report_id: u64, uphold: bool) -> Result<(), Error> {
        let admin = Self::get_admin(&env)?;
        admin.require_auth();

        let mut report = Self::get_report(env.clone(), report_id)?;
        if report.status != ReportStatus::Appealed {
            return Err(Error::AppealNotPending);
        }

        if uphold {
            report.status = ReportStatus::Upheld;
        } else {
            let stake = Self::get_stake(env.clone(), report.verifier.clone());
            env.storage().persistent().set(
                &DataKey::Stake(report.verifier.clone()),
                &(stake + report.amount),
            );
            report.status = ReportStatus::Reversed;
        }
        env.storage()
            .persistent()
            .set(&DataKey::Report(report_id), &report);
        env.events()
            .publish((symbol_short!("resolved"), report_id), uphold);
        Ok(())
    }

    pub fn get_report(env: Env, report_id: u64) -> Result<PenaltyReport, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Report(report_id))
            .ok_or(Error::ReportNotFound)
    }

    pub fn is_evidence_used(env: Env, evidence_hash: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Evidence(evidence_hash))
    }

    pub fn get_stake(env: Env, verifier: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Stake(verifier))
            .unwrap_or(0)
    }

    fn get_admin(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotAdmin)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup(env: &Env) -> (VerifierPenaltyContractClient<'_>, Address) {
        env.mock_all_auths();
        let id = env.register(VerifierPenaltyContract, ());
        let client = VerifierPenaltyContractClient::new(env, &id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        let verifier = Address::generate(env);
        client.stake(&verifier, &10_000);
        (client, verifier)
    }

    fn evidence(env: &Env, b: u8) -> BytesN<32> {
        BytesN::from_array(env, &[b; 32])
    }

    #[test]
    fn test_report_within_cap_succeeds() {
        let env = Env::default();
        let (client, verifier) = setup(&env);
        let id = client.report_offense(&verifier, &OFFENSE_APPROVED_DEAD_TREE, &evidence(&env, 1), &2_000);
        assert_eq!(id, 1);
        assert_eq!(client.get_stake(&verifier), 8_000);
        assert_eq!(client.get_report(&id).status, ReportStatus::Applied);
        assert!(client.is_evidence_used(&evidence(&env, 1)));
    }

    #[test]
    fn test_penalty_above_cap_rejected() {
        let env = Env::default();
        let (client, verifier) = setup(&env);
        // Missed SLA is capped at 5 % (500 of 10_000).
        let r = client.try_report_offense(&verifier, &OFFENSE_MISSED_SLA, &evidence(&env, 1), &501);
        assert_eq!(r, Err(Ok(Error::PenaltyExceedsMax)));
        assert_eq!(client.get_stake(&verifier), 10_000);
    }

    #[test]
    fn test_unknown_offense_and_zero_amount_rejected() {
        let env = Env::default();
        let (client, verifier) = setup(&env);
        assert_eq!(
            client.try_report_offense(&verifier, &99, &evidence(&env, 1), &10),
            Err(Ok(Error::InvalidOffense))
        );
        assert_eq!(
            client.try_report_offense(&verifier, &OFFENSE_MISSED_SLA, &evidence(&env, 1), &0),
            Err(Ok(Error::InvalidAmount))
        );
    }

    #[test]
    fn test_evidence_replay_does_not_compound() {
        let env = Env::default();
        let (client, verifier) = setup(&env);
        client.report_offense(&verifier, &OFFENSE_MISSED_SLA, &evidence(&env, 7), &500);
        let replay = client.try_report_offense(&verifier, &OFFENSE_MISSED_SLA, &evidence(&env, 7), &400);
        assert_eq!(replay, Err(Ok(Error::DuplicateEvidence)));
        // Replay under a different offense is also rejected.
        let replay2 = client.try_report_offense(&verifier, &OFFENSE_FALSIFIED_EVIDENCE, &evidence(&env, 7), &100);
        assert_eq!(replay2, Err(Ok(Error::DuplicateEvidence)));
        assert_eq!(client.get_stake(&verifier), 9_500);
    }

    #[test]
    fn test_unstaked_verifier_rejected() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let other = Address::generate(&env);
        assert_eq!(
            client.try_report_offense(&other, &OFFENSE_MISSED_SLA, &evidence(&env, 1), &1),
            Err(Ok(Error::NotStaked))
        );
    }

    #[test]
    fn test_appeal_reversal_restores_stake_once() {
        let env = Env::default();
        let (client, verifier) = setup(&env);
        let id = client.report_offense(&verifier, &OFFENSE_FALSIFIED_EVIDENCE, &evidence(&env, 2), &3_000);
        client.appeal(&verifier, &id);
        assert_eq!(client.try_appeal(&verifier, &id), Err(Ok(Error::AlreadyAppealed)));
        client.resolve_appeal(&id, &false);
        assert_eq!(client.get_stake(&verifier), 10_000);
        assert_eq!(client.get_report(&id).status, ReportStatus::Reversed);
        // Cannot resolve twice.
        assert_eq!(client.try_resolve_appeal(&id, &false), Err(Ok(Error::AppealNotPending)));
        assert_eq!(client.get_stake(&verifier), 10_000);
    }

    #[test]
    fn test_appeal_upheld_keeps_penalty() {
        let env = Env::default();
        let (client, verifier) = setup(&env);
        let id = client.report_offense(&verifier, &OFFENSE_APPROVED_DEAD_TREE, &evidence(&env, 3), &1_000);
        client.appeal(&verifier, &id);
        client.resolve_appeal(&id, &true);
        assert_eq!(client.get_stake(&verifier), 9_000);
        assert_eq!(client.get_report(&id).status, ReportStatus::Upheld);
    }

    #[test]
    fn test_only_reported_verifier_can_appeal() {
        let env = Env::default();
        let (client, verifier) = setup(&env);
        let id = client.report_offense(&verifier, &OFFENSE_MISSED_SLA, &evidence(&env, 4), &100);
        let stranger = Address::generate(&env);
        assert_eq!(client.try_appeal(&stranger, &id), Err(Ok(Error::NotReportedVerifier)));
        assert_eq!(client.try_appeal(&verifier, &42), Err(Ok(Error::ReportNotFound)));
    }

    #[test]
    fn test_double_initialize_rejected() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let admin2 = Address::generate(&env);
        assert_eq!(client.try_initialize(&admin2), Err(Ok(Error::AlreadyInitialized)));
    }
}
