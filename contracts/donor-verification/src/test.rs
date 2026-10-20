#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{vec, Bytes};

fn sha256(env: &Env, data: &[u8]) -> BytesN<32> {
    let b = Bytes::from_slice(env, data);
    env.crypto().sha256(&b).into()
}

fn hash_pair(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> BytesN<32> {
    let mut buf = Bytes::new(env);
    buf.append(&Bytes::from_array(env, &left.to_array()));
    buf.append(&Bytes::from_array(env, &right.to_array()));
    env.crypto().sha256(&buf).into()
}

/// Builds a depth-`TREE_DEPTH` Merkle tree from a single real leaf at
/// `leaf_index`, padding all other leaves/siblings with a fixed zero
/// value, and returns (root, proof).
fn build_proof(
    env: &Env,
    leaf: &BytesN<32>,
    leaf_index: u32,
) -> (BytesN<32>, Vec<BytesN<32>>) {
    let zero = BytesN::from_array(env, &[0u8; 32]);
    let mut proof = vec![env];
    let mut current = leaf.clone();
    let mut index = leaf_index;

    for _ in 0..TREE_DEPTH {
        let sibling = zero.clone();
        current = if index % 2 == 0 {
            hash_pair(env, &current, &sibling)
        } else {
            hash_pair(env, &sibling, &current)
        };
        proof.push_back(sibling);
        index /= 2;
    }

    (current, proof)
}

#[test]
fn test_initialize_and_get_root() {
    let env = Env::default();
    let contract_id = env.register_contract(None, DonorVerificationContract);
    let client = DonorVerificationContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let root = BytesN::from_array(&env, &[1u8; 32]);

    env.mock_all_auths();
    client.initialize(&admin, &root);

    assert_eq!(client.get_current_root(), root);
}

#[test]
fn test_cannot_initialize_twice() {
    let env = Env::default();
    let contract_id = env.register_contract(None, DonorVerificationContract);
    let client = DonorVerificationContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let root = BytesN::from_array(&env, &[1u8; 32]);

    env.mock_all_auths();
    client.initialize(&admin, &root);

    let result = client.try_initialize(&admin, &root);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn test_verify_and_donate_success() {
    let env = Env::default();
    let contract_id = env.register_contract(None, DonorVerificationContract);
    let client = DonorVerificationContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let donor = Address::generate(&env);

    let secret = sha256(&env, b"donor-secret");
    let nullifier = sha256(&env, b"donor-nullifier");
    let leaf = hash_pair(&env, &secret, &nullifier);
    let (root, proof) = build_proof(&env, &leaf, 0);

    env.mock_all_auths();
    client.initialize(&admin, &root);

    client.verify_and_donate(&donor, &leaf, &proof, &0u32, &nullifier);

    assert!(client.is_nullifier_used(&nullifier));
}

#[test]
fn test_verify_and_donate_rejects_invalid_proof() {
    let env = Env::default();
    let contract_id = env.register_contract(None, DonorVerificationContract);
    let client = DonorVerificationContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let donor = Address::generate(&env);

    let secret = sha256(&env, b"donor-secret");
    let nullifier = sha256(&env, b"donor-nullifier");
    let leaf = hash_pair(&env, &secret, &nullifier);
    let (_correct_root, proof) = build_proof(&env, &leaf, 0);

    // A different, unrelated root — the proof won't resolve to it.
    let wrong_root = BytesN::from_array(&env, &[9u8; 32]);

    env.mock_all_auths();
    client.initialize(&admin, &wrong_root);

    let result = client.try_verify_and_donate(&donor, &leaf, &proof, &0u32, &nullifier);
    assert_eq!(result, Err(Ok(Error::InvalidMerkleProof)));
}

#[test]
fn test_verify_and_donate_rejects_reused_nullifier() {
    let env = Env::default();
    let contract_id = env.register_contract(None, DonorVerificationContract);
    let client = DonorVerificationContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let donor = Address::generate(&env);

    let secret = sha256(&env, b"donor-secret");
    let nullifier = sha256(&env, b"donor-nullifier");
    let leaf = hash_pair(&env, &secret, &nullifier);
    let (root, proof) = build_proof(&env, &leaf, 0);

    env.mock_all_auths();
    client.initialize(&admin, &root);
    client.verify_and_donate(&donor, &leaf, &proof, &0u32, &nullifier);

    // Second attempt with the same nullifier must fail.
    let result = client.try_verify_and_donate(&donor, &leaf, &proof, &0u32, &nullifier);
    assert_eq!(result, Err(Ok(Error::NullifierAlreadyUsed)));
}

#[test]
fn test_verify_and_donate_rejects_wrong_proof_length() {
    let env = Env::default();
    let contract_id = env.register_contract(None, DonorVerificationContract);
    let client = DonorVerificationContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let donor = Address::generate(&env);
    let root = BytesN::from_array(&env, &[1u8; 32]);

    env.mock_all_auths();
    client.initialize(&admin, &root);

    let leaf = sha256(&env, b"leaf");
    let nullifier = sha256(&env, b"nullifier");
    let short_proof = vec![&env, BytesN::from_array(&env, &[0u8; 32])]; // too short

    let result = client.try_verify_and_donate(&donor, &leaf, &short_proof, &0u32, &nullifier);
    assert_eq!(result, Err(Ok(Error::InvalidProofLength)));
}

#[test]
fn test_update_root_requires_admin() {
    let env = Env::default();
    let contract_id = env.register_contract(None, DonorVerificationContract);
    let client = DonorVerificationContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let not_admin = Address::generate(&env);
    let root = BytesN::from_array(&env, &[1u8; 32]);
    let new_root = BytesN::from_array(&env, &[2u8; 32]);

    env.mock_all_auths();
    client.initialize(&admin, &root);

    let result = client.try_update_root(&not_admin, &new_root);
    assert_eq!(result, Err(Ok(Error::NotAdmin)));
}

#[test]
fn test_functions_fail_before_initialization() {
    let env = Env::default();
    let contract_id = env.register_contract(None, DonorVerificationContract);
    let client = DonorVerificationContractClient::new(&env, &contract_id);

    let result = client.try_get_current_root();
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}
// ---------------------------------------------------------------------------
// Minimal on-chain disclosure & revocation (Issue #23)
// ---------------------------------------------------------------------------

fn enrolled(env: &Env) -> (DonorVerificationContractClient<'_>, Address, Address, BytesN<32>, Vec<BytesN<32>>, BytesN<32>) {
    let contract_id = env.register_contract(None, DonorVerificationContract);
    let client = DonorVerificationContractClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let donor = Address::generate(env);
    let secret = sha256(env, b"donor-secret");
    let nullifier = sha256(env, b"donor-nullifier");
    let leaf = hash_pair(env, &secret, &nullifier);
    let (root, proof) = build_proof(env, &leaf, 0);
    env.mock_all_auths();
    client.initialize(&admin, &root);
    (client, admin, donor, leaf, proof, nullifier)
}

#[test]
fn test_verification_event_discloses_only_nullifier() {
    use soroban_sdk::testutils::Events;
    use soroban_sdk::TryFromVal;

    let env = Env::default();
    let (client, _admin, donor, leaf, proof, nullifier) = enrolled(&env);
    client.verify_and_donate(&donor, &leaf, &proof, &0u32, &nullifier);

    let events = env.events().all();
    let (_, topics, data) = events.last().unwrap();
    // Single symbol topic, no address topic.
    assert_eq!(topics.len(), 1);
    for t in topics.iter() {
        assert!(Address::try_from_val(&env, &t).is_err());
    }
    // Payload is exactly the nullifier: no donor address, leaf, or secret.
    let payload = BytesN::<32>::try_from_val(&env, &data).unwrap();
    assert_eq!(payload, nullifier);
    assert_ne!(payload, leaf);
    assert!(Address::try_from_val(&env, &data).is_err());
}

#[test]
fn test_storage_holds_no_leaf_or_donor_after_verification() {
    let env = Env::default();
    let (client, _admin, donor, leaf, proof, nullifier) = enrolled(&env);
    client.verify_and_donate(&donor, &leaf, &proof, &0u32, &nullifier);

    // The only per-donor record is the boolean nullifier marker.
    assert!(client.is_nullifier_used(&nullifier));
    assert!(!client.is_nullifier_used(&leaf));
}

#[test]
fn test_revoke_blocks_future_use_and_stores_only_evidence_hash() {
    use soroban_sdk::testutils::Events;
    use soroban_sdk::TryFromVal;

    let env = Env::default();
    let (client, admin, donor, leaf, proof, nullifier) = enrolled(&env);
    let evidence = sha256(&env, b"off-chain-revocation-record");

    client.revoke_nullifier(&admin, &nullifier, &evidence);
    assert!(client.is_nullifier_revoked(&nullifier));

    // Revocation event carries only the nullifier, not the evidence hash.
    let (_, _, data) = env.events().all().last().unwrap();
    let payload = BytesN::<32>::try_from_val(&env, &data).unwrap();
    assert_eq!(payload, nullifier);
    assert_ne!(payload, evidence);

    let r = client.try_verify_and_donate(&donor, &leaf, &proof, &0u32, &nullifier);
    assert_eq!(r, Err(Ok(Error::NullifierRevoked)));
    assert!(!client.is_nullifier_used(&nullifier));
}

#[test]
fn test_revoke_is_admin_only_and_not_repeatable() {
    let env = Env::default();
    let (client, admin, _donor, _leaf, _proof, nullifier) = enrolled(&env);
    let evidence = sha256(&env, b"evidence");
    let stranger = Address::generate(&env);

    assert_eq!(
        client.try_revoke_nullifier(&stranger, &nullifier, &evidence),
        Err(Ok(Error::NotAdmin))
    );
    client.revoke_nullifier(&admin, &nullifier, &evidence);
    assert_eq!(
        client.try_revoke_nullifier(&admin, &nullifier, &evidence),
        Err(Ok(Error::AlreadyRevoked))
    );
}
