/// Comprehensive tests for operation-registry
/// 
/// Tests verify:
/// 1. Deterministic operation ID computation
/// 2. Collision resistance
/// 3. Cross-contract linking
/// 4. Event chaining

#[cfg(test)]
mod collision_tests {
    use super::super::*;
    use soroban_sdk::testutils::Address as TestAddress;
    use soroban_sdk::{Address, Bytes, Env};

    #[test]
    fn test_operation_id_same_inputs_produce_same_id() {
        let env = Env::new();
        let addr = Address::random(&env);
        let tx_hash = Bytes::from_slice(&env, &[1; 32]);
        let ledger_seq = 12345u32;
        let op_index = 0u32;

        let id1 = OperationId::compute(&addr, &tx_hash, ledger_seq, op_index);
        let id2 = OperationId::compute(&addr, &tx_hash, ledger_seq, op_index);
        let id3 = OperationId::compute(&addr, &tx_hash, ledger_seq, op_index);

        assert_eq!(id1, id2);
        assert_eq!(id2, id3);
    }

    #[test]
    fn test_operation_id_different_addresses_produce_different_ids() {
        let env = Env::new();
        let addr1 = Address::random(&env);
        let addr2 = Address::random(&env);
        let tx_hash = Bytes::from_slice(&env, &[1; 32]);
        let ledger_seq = 12345u32;
        let op_index = 0u32;

        let id1 = OperationId::compute(&addr1, &tx_hash, ledger_seq, op_index);
        let id2 = OperationId::compute(&addr2, &tx_hash, ledger_seq, op_index);

        assert_ne!(id1, id2);
    }

    #[test]
    fn test_operation_id_different_tx_hashes_produce_different_ids() {
        let env = Env::new();
        let addr = Address::random(&env);
        let tx_hash1 = Bytes::from_slice(&env, &[1; 32]);
        let tx_hash2 = Bytes::from_slice(&env, &[2; 32]);
        let ledger_seq = 12345u32;
        let op_index = 0u32;

        let id1 = OperationId::compute(&addr, &tx_hash1, ledger_seq, op_index);
        let id2 = OperationId::compute(&addr, &tx_hash2, ledger_seq, op_index);

        assert_ne!(id1, id2);
    }

    #[test]
    fn test_operation_id_different_ledger_seq_produce_different_ids() {
        let env = Env::new();
        let addr = Address::random(&env);
        let tx_hash = Bytes::from_slice(&env, &[1; 32]);
        let op_index = 0u32;

        let id1 = OperationId::compute(&addr, &tx_hash, 12345u32, op_index);
        let id2 = OperationId::compute(&addr, &tx_hash, 12346u32, op_index);

        assert_ne!(id1, id2);
    }

    #[test]
    fn test_operation_id_different_op_index_produce_different_ids() {
        let env = Env::new();
        let addr = Address::random(&env);
        let tx_hash = Bytes::from_slice(&env, &[1; 32]);
        let ledger_seq = 12345u32;

        let id1 = OperationId::compute(&addr, &tx_hash, ledger_seq, 0u32);
        let id2 = OperationId::compute(&addr, &tx_hash, ledger_seq, 1u32);
        let id3 = OperationId::compute(&addr, &tx_hash, ledger_seq, 255u32);

        assert_ne!(id1, id2);
        assert_ne!(id1, id3);
        assert_ne!(id2, id3);
    }

    #[test]
    fn test_operation_id_boundary_values() {
        let env = Env::new();
        let addr = Address::random(&env);
        let tx_hash = Bytes::from_slice(&env, &[0xFF; 32]);

        // Test boundary values
        let id_zero = OperationId::compute(&addr, &tx_hash, 0u32, 0u32);
        let id_max = OperationId::compute(&addr, &tx_hash, u32::MAX, u32::MAX);
        let id_mid = OperationId::compute(&addr, &tx_hash, u32::MAX / 2, u32::MAX / 2);

        assert_ne!(id_zero, id_max);
        assert_ne!(id_zero, id_mid);
        assert_ne!(id_max, id_mid);
    }

    #[test]
    fn test_operation_metadata_structure() {
        let env = Env::new();
        let addr = Address::random(&env);
        let tx_hash = Bytes::from_slice(&env, &[42; 32]);
        let ledger_seq = 100u32;
        let op_index = 5u32;

        let metadata = OperationMetadata {
            operation_id: 12345u64,
            contract_addr: addr.clone(),
            tx_hash: tx_hash.clone(),
            ledger_seq,
            op_index,
            created_at: 1000u64,
        };

        assert_eq!(metadata.operation_id, 12345u64);
        assert_eq!(metadata.ledger_seq, 100u32);
        assert_eq!(metadata.op_index, 5u32);
    }

    #[test]
    fn test_event_record_structure() {
        let env = Env::new();
        let event = EventRecord {
            event_type: Symbol::new(&env, "StreamCreated"),
            timestamp: 1234567890u64,
            ledger_seq: 12345u32,
            related_entity_id: 999u64,
        };

        assert_eq!(event.timestamp, 1234567890u64);
        assert_eq!(event.ledger_seq, 12345u32);
        assert_eq!(event.related_entity_id, 999u64);
    }

    #[test]
    fn test_multiple_operations_same_tx_different_indices() {
        let env = Env::new();
        let addr = Address::random(&env);
        let tx_hash = Bytes::from_slice(&env, &[99; 32]);
        let ledger_seq = 50000u32;

        let mut ids = Vec::new();
        for i in 0u32..10u32 {
            let id = OperationId::compute(&addr, &tx_hash, ledger_seq, i);
            ids.push(id);
        }

        // Verify all are unique
        for i in 0..ids.len() {
            for j in (i + 1)..ids.len() {
                assert_ne!(
                    ids[i], ids[j],
                    "Operation IDs at indices {} and {} should differ",
                    i, j
                );
            }
        }
    }

    #[test]
    fn test_large_scale_operation_ids() {
        let env = Env::new();
        let addr = Address::random(&env);
        let tx_hash = Bytes::from_slice(&env, &[7; 32]);

        let mut ids = std::collections::HashSet::new();

        // Generate 1000 operation IDs with different parameters
        for ledger in 0u32..10u32 {
            for op_idx in 0u32..100u32 {
                let id = OperationId::compute(&addr, &tx_hash, ledger, op_idx);
                assert!(
                    ids.insert(id),
                    "Duplicate operation ID generated at ledger={}, op_idx={}",
                    ledger,
                    op_idx
                );
            }
        }

        assert_eq!(ids.len(), 1000, "Expected 1000 unique operation IDs");
    }
}

#[cfg(test)]
mod cross_contract_tests {
    use super::super::*;
    use soroban_sdk::{Address, Bytes, Env};

    #[test]
    fn test_operations_from_different_contracts_have_different_ids() {
        let env = Env::new();
        let contract1 = Address::random(&env);
        let contract2 = Address::random(&env);
        let tx_hash = Bytes::from_slice(&env, &[55; 32]);
        let ledger_seq = 99999u32;
        let op_index = 0u32;

        let id1 = OperationId::compute(&contract1, &tx_hash, ledger_seq, op_index);
        let id2 = OperationId::compute(&contract2, &tx_hash, ledger_seq, op_index);

        assert_ne!(
            id1, id2,
            "Operations from different contracts must have different IDs"
        );
    }

    #[test]
    fn test_same_operation_id_across_verification_calls() {
        let env = Env::new();
        let addr = Address::random(&env);
        let tx_hash = Bytes::from_slice(&env, &[123; 32]);
        let ledger_seq = 55555u32;
        let op_index = 3u32;

        // Simulate client-side verification computing the same ID
        let server_id = OperationId::compute(&addr, &tx_hash, ledger_seq, op_index);
        let client_id = OperationId::compute(&addr, &tx_hash, ledger_seq, op_index);

        assert_eq!(
            server_id, client_id,
            "Client-side verification must produce identical operation IDs"
        );
    }
}

#[cfg(test)]
mod datakey_tests {
    use super::super::*;

    #[test]
    fn test_operation_data_key_variants() {
        // Test that DataKey enum variants are correctly structured
        let key1 = OperationDataKey::OperationIdRegistry(1u64);
        let key2 = OperationDataKey::OperationIdRegistry(2u64);
        let key3 = OperationDataKey::OperationEvents(1u64);

        // These should serialize differently
        assert_ne!(
            format!("{:?}", key1),
            format!("{:?}", key2),
            "Different operation IDs should be distinguishable"
        );
        assert_ne!(
            format!("{:?}", key1),
            format!("{:?}", key3),
            "Different key types should be distinguishable"
        );
    }
}
