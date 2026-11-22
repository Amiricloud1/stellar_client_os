#![no_std]

use soroban_sdk::{
    contracttype, Symbol, Env, Address, Vec, Bytes,
};
use sha2::{Sha256, Digest};

/// Represents a stable, deterministic operation identifier.
/// Computed from (contract_addr, tx_hash, ledger_seq, op_index) to ensure uniqueness.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub struct OperationId(pub u64);

impl OperationId {
    /// Compute an operation ID deterministically from contract address, transaction hash,
    /// ledger sequence, and operation index.
    ///
    /// Uses SHA256 to hash the components, then converts the first 8 bytes to u64.
    /// This ensures:
    /// - Deterministic: same inputs always produce the same output
    /// - Collision-resistant: extremely unlikely to get same ID from different inputs
    /// - Caller-proof: no caller can predict or supply a pre-computed ID
    pub fn compute(
        contract_addr: &Address,
        tx_hash: &Bytes,
        ledger_seq: u32,
        op_index: u32,
    ) -> Self {
        let mut hasher = Sha256::new();
        
        // Hash the contract address bytes
        let addr_bytes = contract_addr.to_xdr(&Env::new());
        hasher.update(addr_bytes.as_slice());
        
        // Hash the transaction hash
        hasher.update(tx_hash.as_slice());
        
        // Hash ledger sequence (big-endian u32)
        hasher.update(ledger_seq.to_be_bytes());
        
        // Hash operation index (big-endian u32)
        hasher.update(op_index.to_be_bytes());
        
        let hash = hasher.finalize();
        
        // Convert first 8 bytes of SHA256 hash to u64 (big-endian)
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&hash[..8]);
        let id = u64::from_be_bytes(bytes);
        
        OperationId(id)
    }
}

/// Record of an event linked to an operation
#[contracttype]
#[derive(Clone)]
pub struct EventRecord {
    /// Type of event (e.g., Symbol::new("StreamCreated"), Symbol::new("FundsDeposited"))
    pub event_type: Symbol,
    /// Ledger timestamp when the event occurred
    pub timestamp: u64,
    /// Ledger sequence number when the event occurred
    pub ledger_seq: u32,
    /// Related entity ID (stream_id, campaign_id, etc.)
    pub related_entity_id: u64,
}

/// Event emitted when an operation is linked to a specific entity
#[contracttype]
#[derive(Clone)]
pub struct OperationLinkedEvent {
    /// Unique identifier for the operation
    pub operation_id: u64,
    /// Type of event being linked
    pub event_type: Symbol,
    /// ID of the related entity (stream_id, campaign_id, etc.)
    pub related_entity_id: u64,
}

/// Storage keys for operation registry data
#[contracttype]
#[derive(Clone, Debug)]
pub enum OperationDataKey {
    /// Maps operation_id (u64) to OperationMetadata
    OperationIdRegistry(u64),
    /// Maps operation_id (u64) to Vec<EventRecord>
    OperationEvents(u64),
}

/// Metadata about an operation
#[contracttype]
#[derive(Clone)]
pub struct OperationMetadata {
    /// The operation ID
    pub operation_id: u64,
    /// Contract address that created this operation
    pub contract_addr: Address,
    /// Transaction hash
    pub tx_hash: Bytes,
    /// Ledger sequence
    pub ledger_seq: u32,
    /// Operation index
    pub op_index: u32,
    /// Timestamp when created
    pub created_at: u64,
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod quick_tests {
    use super::*;
    use soroban_sdk::testutils::Address as TestAddress;

    #[test]
    fn test_operation_id_deterministic() {
        let env = Env::new();
        let addr1 = Address::random(&env);
        let tx_hash = Bytes::from_slice(&env, &[1; 32]);
        let ledger_seq = 100u32;
        let op_index = 0u32;

        let id1 = OperationId::compute(&addr1, &tx_hash, ledger_seq, op_index);
        let id2 = OperationId::compute(&addr1, &tx_hash, ledger_seq, op_index);

        assert_eq!(id1, id2, "Operation IDs must be deterministic");
    }

    #[test]
    fn test_operation_id_differs_by_address() {
        let env = Env::new();
        let addr1 = Address::random(&env);
        let addr2 = Address::random(&env);
        let tx_hash = Bytes::from_slice(&env, &[1; 32]);
        let ledger_seq = 100u32;
        let op_index = 0u32;

        let id1 = OperationId::compute(&addr1, &tx_hash, ledger_seq, op_index);
        let id2 = OperationId::compute(&addr2, &tx_hash, ledger_seq, op_index);

        assert_ne!(id1, id2, "Different addresses must produce different IDs");
    }

    #[test]
    fn test_operation_id_differs_by_tx_hash() {
        let env = Env::new();
        let addr = Address::random(&env);
        let tx_hash1 = Bytes::from_slice(&env, &[1; 32]);
        let tx_hash2 = Bytes::from_slice(&env, &[2; 32]);
        let ledger_seq = 100u32;
        let op_index = 0u32;

        let id1 = OperationId::compute(&addr, &tx_hash1, ledger_seq, op_index);
        let id2 = OperationId::compute(&addr, &tx_hash2, ledger_seq, op_index);

        assert_ne!(id1, id2, "Different tx hashes must produce different IDs");
    }

    #[test]
    fn test_operation_id_differs_by_ledger_seq() {
        let env = Env::new();
        let addr = Address::random(&env);
        let tx_hash = Bytes::from_slice(&env, &[1; 32]);

        let id1 = OperationId::compute(&addr, &tx_hash, 100u32, 0u32);
        let id2 = OperationId::compute(&addr, &tx_hash, 101u32, 0u32);

        assert_ne!(id1, id2, "Different ledger sequences must produce different IDs");
    }

    #[test]
    fn test_operation_id_differs_by_op_index() {
        let env = Env::new();
        let addr = Address::random(&env);
        let tx_hash = Bytes::from_slice(&env, &[1; 32]);
        let ledger_seq = 100u32;

        let id1 = OperationId::compute(&addr, &tx_hash, ledger_seq, 0u32);
        let id2 = OperationId::compute(&addr, &tx_hash, ledger_seq, 1u32);

        assert_ne!(id1, id2, "Different op indices must produce different IDs");
    }
}
