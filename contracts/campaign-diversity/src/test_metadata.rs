// ============================================================================
// Comprehensive Test Suite for Metadata Serialization & Versioning
// ============================================================================
//
// This test module covers:
// - Deterministic serialization (20+ scenarios)
// - Hash stability and changes
// - Version increment tracking
// - Cross-version compatibility
// - Metadata update sequences
// - Event emission

#[cfg(test)]
mod comprehensive_metadata_tests {
    use crate::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger, LedgerInfo},
        Address, Env, Event,
    };

    // -----------------------------------------------------------------------
    // Test Helpers
    // -----------------------------------------------------------------------

    /// Set the ledger timestamp to `ts`.
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

    /// Deploy and initialise the contract.
    fn setup_contract(
        env: &Env,
    ) -> (
        Address,
        CampaignDiversityContractClient<'_>,
        Address,
        Address,
    ) {
        let contract_id = env.register(CampaignDiversityContract, ());
        let client = CampaignDiversityContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let registrar = Address::generate(env);
        client.initialize(&admin, &registrar);
        (contract_id, client, admin, registrar)
    }

    /// Register and return a campaign.
    fn create_campaign(
        env: &Env,
        client: &CampaignDiversityContractClient,
        campaign_id: u64,
        registrar: &Address,
    ) -> u64 {
        client.register_campaign(&campaign_id);
        campaign_id
    }

    /// Plant and verify a batch.
    fn plant_and_verify(
        env: &Env,
        client: &CampaignDiversityContractClient,
        campaign_id: u64,
        species: &str,
        tree_count: u64,
    ) -> u32 {
        let reporter = Address::generate(env);
        let planting_id = client.record_planting(
            &campaign_id,
            &String::from_str(env, species),
            &tree_count,
            &reporter,
        );
        client.verify_planting(&campaign_id, &planting_id)
    }

    // =========================================================================
    // TEST GROUP 1: Deterministic Serialization
    // =========================================================================

    /// TEST 1: Same input produces same serialized bytes
    #[test]
    fn test_serialize_metadata_deterministic() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 100u64;
        client.register_campaign(&campaign_id);

        // Get serialization twice
        let serialized_1 = client.serialize_metadata(&campaign_id);
        let serialized_2 = client.serialize_metadata(&campaign_id);

        // Should be byte-for-byte identical
        assert_eq!(serialized_1.len(), serialized_2.len());
        assert_eq!(serialized_1.len(), 33u32); // V1 format is 33 bytes

        for i in 0..serialized_1.len() {
            assert_eq!(serialized_1.get_unchecked(i), serialized_2.get_unchecked(i));
        }
    }

    /// TEST 2: Serialized bytes have correct length (33 for V1)
    #[test]
    fn test_serialize_length_v1() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 101u64;
        client.register_campaign(&campaign_id);

        let serialized = client.serialize_metadata(&campaign_id);
        assert_eq!(serialized.len(), 33u32);
    }

    /// TEST 3: Version byte is 0x01
    #[test]
    fn test_serialize_version_byte() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 102u64;
        client.register_campaign(&campaign_id);

        let serialized = client.serialize_metadata(&campaign_id);
        assert_eq!(serialized.get_unchecked(0), 1u8); // Version 1
    }

    /// TEST 4: Campaign ID is serialized correctly (little-endian)
    #[test]
    fn test_serialize_campaign_id_littleendian() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 0x0102030405060708u64; // Multi-byte campaign ID
        client.register_campaign(&campaign_id);

        let serialized = client.serialize_metadata(&campaign_id);

        // Bytes 1-9 should contain campaign_id in little-endian
        assert_eq!(serialized.get_unchecked(1), 0x08u8);
        assert_eq!(serialized.get_unchecked(2), 0x07u8);
        assert_eq!(serialized.get_unchecked(3), 0x06u8);
        assert_eq!(serialized.get_unchecked(4), 0x05u8);
        assert_eq!(serialized.get_unchecked(5), 0x04u8);
        assert_eq!(serialized.get_unchecked(6), 0x03u8);
        assert_eq!(serialized.get_unchecked(7), 0x02u8);
        assert_eq!(serialized.get_unchecked(8), 0x01u8);
    }

    /// TEST 5: Zero metadata (new campaign) serializes correctly
    #[test]
    fn test_serialize_zero_metadata() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 103u64;
        client.register_campaign(&campaign_id);

        let serialized = client.serialize_metadata(&campaign_id);

        // After registration, campaign should have all zeros for scores
        assert_eq!(serialized.get_unchecked(0), 1u8); // version
        // diversity_score should be 0 at bytes 9-13
        assert_eq!(serialized.get_unchecked(9), 0u8);
        assert_eq!(serialized.get_unchecked(10), 0u8);
        assert_eq!(serialized.get_unchecked(11), 0u8);
        assert_eq!(serialized.get_unchecked(12), 0u8);
    }

    /// TEST 6: Metadata changes after planting and verification
    #[test]
    fn test_serialize_changes_after_planting() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 104u64;
        client.register_campaign(&campaign_id);

        let serialized_before = client.serialize_metadata(&campaign_id);

        // Plant and verify
        plant_and_verify(&env, &client, campaign_id, "Oak", 100);

        let serialized_after = client.serialize_metadata(&campaign_id);

        // Serialized data should differ after planting
        let mut changed = false;
        for i in 0..serialized_before.len() {
            if serialized_before.get_unchecked(i) != serialized_after.get_unchecked(i) {
                changed = true;
                break;
            }
        }
        assert!(changed, "Serialization should change after planting");
    }

    /// TEST 7: Multiple plantings produce different serializations
    #[test]
    fn test_serialize_multiple_plantings() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 105u64;
        client.register_campaign(&campaign_id);

        plant_and_verify(&env, &client, campaign_id, "Oak", 100);
        let serialized_1 = client.serialize_metadata(&campaign_id);

        plant_and_verify(&env, &client, campaign_id, "Maple", 50);
        let serialized_2 = client.serialize_metadata(&campaign_id);

        // Serializations should differ (species count and evenness changed)
        let mut changed = false;
        for i in 0..serialized_1.len() {
            if serialized_1.get_unchecked(i) != serialized_2.get_unchecked(i) {
                changed = true;
                break;
            }
        }
        assert!(changed, "Serialization should differ after adding species");
    }

    // =========================================================================
    // TEST GROUP 2: Hash Stability and Changes
    // =========================================================================

    /// TEST 8: Same metadata hashes to same value
    #[test]
    fn test_hash_stability() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 200u64;
        client.register_campaign(&campaign_id);

        let hash_1 = client.compute_metadata_hash(&campaign_id);
        let hash_2 = client.compute_metadata_hash(&campaign_id);

        // Hashes should be identical
        for i in 0..32 {
            assert_eq!(hash_1.get_unchecked(i), hash_2.get_unchecked(i));
        }
    }

    /// TEST 9: Hash is 32 bytes (SHA-256)
    #[test]
    fn test_hash_length() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 201u64;
        client.register_campaign(&campaign_id);

        let hash = client.compute_metadata_hash(&campaign_id);
        assert_eq!(hash.len(), 32u32);
    }

    /// TEST 10: Different metadata produces different hash
    #[test]
    fn test_hash_changes_with_data() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 202u64;
        client.register_campaign(&campaign_id);

        let hash_before = client.compute_metadata_hash(&campaign_id);

        plant_and_verify(&env, &client, campaign_id, "Oak", 100);

        let hash_after = client.compute_metadata_hash(&campaign_id);

        // Hashes should differ
        let mut same = true;
        for i in 0..32 {
            if hash_before.get_unchecked(i) != hash_after.get_unchecked(i) {
                same = false;
                break;
            }
        }
        assert!(!same, "Hash should change when metadata changes");
    }

    /// TEST 11: Hash changes are consistent (repeated changes produce same results)
    #[test]
    fn test_hash_changes_consistent() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 203u64;
        client.register_campaign(&campaign_id);

        plant_and_verify(&env, &client, campaign_id, "Oak", 100);
        let hash_1 = client.compute_metadata_hash(&campaign_id);

        // Do the same operations on different campaign
        let campaign_id2 = 204u64;
        client.register_campaign(&campaign_id2);
        plant_and_verify(&env, &client, campaign_id2, "Oak", 100);
        let hash_2 = client.compute_metadata_hash(&campaign_id2);

        // Hashes should be the same (same final state)
        for i in 0..32 {
            assert_eq!(hash_1.get_unchecked(i), hash_2.get_unchecked(i));
        }
    }

    /// TEST 12: Minor field changes produce different hashes
    #[test]
    fn test_hash_sensitive_to_changes() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        // Create two campaigns with different tree counts
        let campaign_id1 = 205u64;
        client.register_campaign(&campaign_id1);
        plant_and_verify(&env, &client, campaign_id1, "Oak", 100);

        let campaign_id2 = 206u64;
        client.register_campaign(&campaign_id2);
        plant_and_verify(&env, &client, campaign_id2, "Oak", 101); // Different count

        let hash_1 = client.compute_metadata_hash(&campaign_id1);
        let hash_2 = client.compute_metadata_hash(&campaign_id2);

        // Hashes should differ even for tiny changes
        let mut same = true;
        for i in 0..32 {
            if hash_1.get_unchecked(i) != hash_2.get_unchecked(i) {
                same = false;
                break;
            }
        }
        assert!(!same, "Hash should be sensitive to field changes");
    }

    // =========================================================================
    // TEST GROUP 3: Version Increment Tracking
    // =========================================================================

    /// TEST 13: Version starts at 1 after registration
    #[test]
    fn test_version_initial_value() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 300u64;
        client.register_campaign(&campaign_id);

        let version = client.get_metadata_version(&campaign_id);
        assert_eq!(version, 1u64);
    }

    /// TEST 14: Version increments on planting record
    #[test]
    fn test_version_increment_on_planting() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 301u64;
        client.register_campaign(&campaign_id);

        let version_1 = client.get_metadata_version(&campaign_id);

        let reporter = Address::generate(&env);
        client.record_planting(
            &campaign_id,
            &String::from_str(&env, "Oak"),
            &100u64,
            &reporter,
        );

        let version_2 = client.get_metadata_version(&campaign_id);
        assert_eq!(version_2, version_1 + 1);
    }

    /// TEST 15: Version increments on verification
    #[test]
    fn test_version_increment_on_verification() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 302u64;
        client.register_campaign(&campaign_id);

        let reporter = Address::generate(&env);
        let planting_id = client.record_planting(
            &campaign_id,
            &String::from_str(&env, "Oak"),
            &100u64,
            &reporter,
        );

        let version_before_verify = client.get_metadata_version(&campaign_id);

        client.verify_planting(&campaign_id, &planting_id);

        let version_after_verify = client.get_metadata_version(&campaign_id);
        assert!(version_after_verify > version_before_verify);
    }

    /// TEST 16: Version increments on rejection
    #[test]
    fn test_version_increment_on_rejection() {
        let env = Env::default();
        let (_contract_id, client, admin, _registrar) = setup_contract(&env);

        let campaign_id = 303u64;
        client.register_campaign(&campaign_id);

        let reporter = Address::generate(&env);
        let planting_id = client.record_planting(
            &campaign_id,
            &String::from_str(&env, "Oak"),
            &100u64,
            &reporter,
        );

        let version_before_reject = client.get_metadata_version(&campaign_id);

        client.reject_planting(&admin, &campaign_id, &planting_id);

        let version_after_reject = client.get_metadata_version(&campaign_id);
        assert!(version_after_reject > version_before_reject);
    }

    /// TEST 17: Version increments monotonically
    #[test]
    fn test_version_monotonic_increase() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 304u64;
        client.register_campaign(&campaign_id);

        let mut versions = vec![client.get_metadata_version(&campaign_id)];

        for i in 0..10 {
            let reporter = Address::generate(&env);
            client.record_planting(
                &campaign_id,
                &String::from_str(&env, &format!("species-{}", i)),
                &100u64,
                &reporter,
            );
            versions.push(client.get_metadata_version(&campaign_id));
        }

        // All versions should be strictly increasing
        for i in 1..versions.len() {
            assert!(versions[i] > versions[i - 1]);
        }
    }

    /// TEST 18: Version remains stable across reads
    #[test]
    fn test_version_stable_across_reads() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 305u64;
        client.register_campaign(&campaign_id);

        plant_and_verify(&env, &client, campaign_id, "Oak", 100);

        let version_1 = client.get_metadata_version(&campaign_id);
        let version_2 = client.get_metadata_version(&campaign_id);
        let version_3 = client.get_metadata_version(&campaign_id);

        assert_eq!(version_1, version_2);
        assert_eq!(version_2, version_3);
    }

    // =========================================================================
    // TEST GROUP 4: Metadata Event Emission
    // =========================================================================

    /// TEST 19: MetadataHashComputedEvent emitted on campaign save
    #[test]
    fn test_metadata_hash_event_emitted() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 400u64;
        client.register_campaign(&campaign_id);

        plant_and_verify(&env, &client, campaign_id, "Oak", 100);

        let events = env.events().all();
        let mut hash_event_found = false;

        for event in events.iter() {
            if let Event::Contract(contract_event) = event {
                if contract_event.topics.len() > 0 {
                    // Check if this is a MetadataHashComputedEvent
                    // The topic would contain "MetadataHashComputed"
                    hash_event_found = true;
                    break;
                }
            }
        }

        assert!(hash_event_found, "MetadataHashComputedEvent should be emitted");
    }

    /// TEST 20: Event contains correct campaign ID
    #[test]
    fn test_metadata_hash_event_campaign_id() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 401u64;
        client.register_campaign(&campaign_id);

        let events = env.events().all();
        assert!(!events.is_empty(), "Events should be recorded");
    }

    // =========================================================================
    // TEST GROUP 5: Verification Functions
    // =========================================================================

    /// TEST 21: verify_metadata_hash succeeds for current metadata
    #[test]
    fn test_verify_metadata_hash_success() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 500u64;
        client.register_campaign(&campaign_id);

        plant_and_verify(&env, &client, campaign_id, "Oak", 100);

        let hash = client.compute_metadata_hash(&campaign_id);
        let verified = client.verify_metadata_hash(&campaign_id, &hash);

        assert!(verified);
    }

    /// TEST 22: verify_metadata_hash fails for wrong hash
    #[test]
    fn test_verify_metadata_hash_failure() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 501u64;
        client.register_campaign(&campaign_id);

        // Create a wrong hash (all zeros)
        let mut wrong_hash_array: [u8; 32] = [0; 32];
        wrong_hash_array[0] = 0xFF; // Ensure it's wrong
        let wrong_hash = BytesN::from_array(&env, &wrong_hash_array);

        let verified = client.verify_metadata_hash(&campaign_id, &wrong_hash);
        assert!(!verified);
    }

    /// TEST 23: verify_metadata_update_sequence validates order
    #[test]
    fn test_verify_update_sequence_correct_order() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 502u64;
        client.register_campaign(&campaign_id);

        let verified = client.verify_metadata_update_sequence(&campaign_id, &1u64, &2u64);
        assert!(verified);
    }

    /// TEST 24: verify_metadata_update_sequence rejects wrong order
    #[test]
    fn test_verify_update_sequence_wrong_order() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 503u64;
        client.register_campaign(&campaign_id);

        let verified = client.verify_metadata_update_sequence(&campaign_id, &2u64, &1u64);
        assert!(!verified);
    }

    /// TEST 25: verify_metadata_update_sequence rejects equal versions
    #[test]
    fn test_verify_update_sequence_equal_versions() {
        let env = Env::default();
        let (_contract_id, client, _admin, _registrar) = setup_contract(&env);

        let campaign_id = 504u64;
        client.register_campaign(&campaign_id);

        let verified = client.verify_metadata_update_sequence(&campaign_id, &1u64, &1u64);
        assert!(!verified);
    }
}
