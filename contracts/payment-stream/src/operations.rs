/// Operations module integrating with operation-registry
/// 
/// This module handles:
/// - Computing operation IDs for key operations
/// - Emitting operation-linked events
/// - Storing operation metadata in the registry

use soroban_sdk::{contractevent, contracttype, Address, Bytes, Env, Symbol};
use operation_registry::{OperationId, OperationMetadata, OperationLinkedEvent, EventRecord};

/// Event emitted when an operation is created and registered
#[contractevent(topics = ["OperationLinked"])]
#[derive(Clone)]
pub struct OperationLinkedEventEmitted {
    pub operation_id: u64,
    pub event_type: Symbol,
    pub related_entity_id: u64,
}

/// Data key for storing operation metadata in payment-stream
#[contracttype]
#[derive(Clone, Debug)]
pub enum OperationDataKey {
    /// Maps stream_id → operation_id (links streams to their creation operation)
    StreamOperation(u64),
}

/// Computes an operation ID for a payment-stream operation
///
/// In a real implementation, this would use the actual transaction hash and ledger info
/// For now, it takes a manually provided tx_hash as a proxy
pub fn compute_operation_id(
    env: &Env,
    tx_hash: &Bytes,
    operation_index: u32,
) -> u64 {
    let contract_addr = env.current_contract_address();
    let ledger_seq = env.ledger().sequence();
    
    let op_id = OperationId::compute(
        &contract_addr,
        tx_hash,
        ledger_seq,
        operation_index,
    );
    
    op_id.0
}

/// Records a stream creation operation
///
/// Emits an OperationLinkedEvent and links the stream to its creation operation
pub fn register_stream_created(
    env: &Env,
    stream_id: u64,
    operation_id: u64,
    sender: &Address,
) {
    let timestamp = env.ledger().timestamp();
    
    // Emit the operation linked event
    OperationLinkedEventEmitted {
        operation_id,
        event_type: Symbol::new(env, "StreamCreated"),
        related_entity_id: stream_id,
    }
    .publish(env);
    
    // Store link from stream to operation (for auditing)
    let key = OperationDataKey::StreamOperation(stream_id);
    env.storage().persistent().set(&key, &operation_id);
}

/// Records a deposit operation
pub fn register_deposit(
    env: &Env,
    stream_id: u64,
    operation_id: u64,
    amount: i128,
) {
    // Emit the operation linked event
    OperationLinkedEventEmitted {
        operation_id,
        event_type: Symbol::new(env, "Deposited"),
        related_entity_id: stream_id,
    }
    .publish(env);
}

/// Records a withdrawal operation
pub fn register_withdrawal(
    env: &Env,
    stream_id: u64,
    operation_id: u64,
    amount: i128,
) {
    // Emit the operation linked event
    OperationLinkedEventEmitted {
        operation_id,
        event_type: Symbol::new(env, "Withdrawn"),
        related_entity_id: stream_id,
    }
    .publish(env);
}
