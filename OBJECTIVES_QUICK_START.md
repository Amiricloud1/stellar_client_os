# Quick Start: Using the Four Objectives

This guide shows how to use the implemented objectives in your code.

## 1️⃣ Operation Nonces & Recovery

### Use Case: Multi-step payment stream operation

```rust
use crate::operations::{OperationNonce, check_or_create_recovery, save_recovery_step, complete_operation};

pub fn process_complex_payment(env: Env, stream_id: u64, amount: i128) -> Result<(), Error> {
    // Step 1: Create nonce to track this operation
    let nonce = OperationNonce::from_env(&env, 0);
    
    // Step 2: Check if we're recovering from a previous failure
    if let Some(mut recovery) = check_or_create_recovery(&env, &nonce, 3) {
        // We're in recovery path - resume from last checkpoint
        match recovery.step {
            0 => {
                // Step 1 already done
            }
            1 => {
                // Resume from step 2
            }
            2 => {
                // Complete step 3
            }
            _ => {}
        }
        return Ok(());
    }
    
    // Step 3: Normal path - perform operation
    // Step 1: Validate
    validate_payment(&env, stream_id, amount)?;
    save_recovery_step(&env, &nonce, 1, Vec::new(&env));
    
    // Step 2: Transfer
    transfer_tokens(&env, stream_id, amount)?;
    save_recovery_step(&env, &nonce, 2, Vec::new(&env));
    
    // Step 3: Update metrics
    update_metrics(&env, stream_id, amount);
    
    // Step 4: Mark complete
    complete_operation(&env, &nonce);
    
    Ok(())
}
```

## 2️⃣ Token Decimals & Asset Identity

### Use Case: Create stream with correct decimal handling

```typescript
import { TokenValidator, buildAmountEventMetadata } from '@fundable/sdk';

async function createStreamWithValidation(
  contractId: string,
  sender: string,
  recipient: string,
  tokenAddress: string,
  amount: number // human-readable amount (e.g., 100.5 USDC)
) {
  const validator = new TokenValidator();
  
  // Step 1: Register token at stream inception
  const asset = validator.registerTokenAsset(
    tokenAddress,
    6,              // USDC has 6 decimals
    'USD Coin',
    'U',
    'GBUQWP3BOUZX34ULNQG23RQ6F4BFXEEHRM2BLZ', // issuer
    'USDC'
  );
  
  // Step 2: Convert amount to native units using frozen decimals
  const amountInNativeUnits = validator.toNativeUnits(tokenAddress, amount);
  // For amount=100.5, returns: 100_500_000n (6 decimal places)
  
  // Step 3: Create stream
  const tx = await client.createStream({
    recipient,
    token: tokenAddress,
    totalAmount: amountInNativeUnits.toString(),
    startTime: Math.floor(Date.now() / 1000),
    endTime: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
    cliffDuration: 0,
  });
  
  // Step 4: Build event metadata for audit
  const metadata = buildAmountEventMetadata(
    validator,
    tokenAddress,
    amountInNativeUnits
  );
  console.log('Stream created with metadata:', metadata);
  // {
  //   amountInNativeUnits: 100500000n,
  //   amountHumanReadable: "100.500000",
  //   tokenDecimals: 6,
  //   tokenAddress: "CABC..."
  // }
}
```

### Validating Decimals Never Change

```typescript
// At withdrawal time, verify decimals are still correct
async function withdrawFromStream(
  client: PaymentStreamClient,
  streamId: string,
  amountToWithdraw: string // human-readable
) {
  const validator = new TokenValidator();
  const stream = await client.getStream(streamId);
  
  // Verify decimals haven't changed
  try {
    validator.validateDecimals(stream.token, 6); // Throws if not 6
  } catch (error) {
    throw new Error(`Token decimal drift detected: ${error.message}`);
  }
  
  // Safe to convert human-readable to native units
  const amount = validator.toNativeUnits(stream.token, amountToWithdraw);
  return await client.withdraw(streamId, amount.toString());
}
```

## 3️⃣ Fund Authorization Boundaries

### Use Case: Disburse emergency funds with authorization

```rust
use crate::fund_authorization::{
    FundPurpose, AuthorizationLevel, withdraw_from_fund, initialize_fund_authorization
};

pub fn setup_fund_authorization(env: Env, admin: Address) {
    // Initialize all fund categories with default policies
    initialize_fund_authorization(&env, &admin);
}

pub fn disburse_emergency_funds(
    env: Env,
    amount: i128,
    recipient: Address,
    approvers: Vec<Address>, // Multi-sig approvers
) -> Result<i128, &'static str> {
    // Emergency fund requires multi-sig (see initialization)
    // Will fail if:
    // - Less than 2 approvers provided
    // - Amount exceeds per-transaction limit
    // - Amount exceeds per-day limit
    // - Recipient not in allowlist
    // - Spending already done today
    
    let new_balance = withdraw_from_fund(
        &env,
        FundPurpose::Emergency,
        amount,
        &recipient,
        approvers,
    )?;
    
    Ok(new_balance)
}
```

## 4️⃣ Liability Change Traceability

### Part A: Emit Events with Full Traceability (Contract Side)

```rust
use crate::events::{EventReference, emit_withdraw_with_reference};
use crate::operations::OperationNonce;

pub fn withdraw_with_traceability(
    env: Env,
    stream_id: u64,
    amount: i128,
) -> Result<i128, Error> {
    // Get operation nonce
    let nonce = OperationNonce::from_env(&env, 0);
    
    // Get stream data
    let stream = get_stream(&env, stream_id)?;
    
    // Perform withdrawal
    let remaining = stream.balance - amount;
    
    // Emit event with full traceability
    let event_ref = EventReference::from_operation(
        &env,
        nonce,
        hash_event_data(&stream_id, &amount), // Hash for integrity
    );
    
    emit_withdraw_with_reference(
        &env,
        event_ref,
        stream_id,
        &stream.recipient,
        amount,
        remaining,
        6,                    // token decimals (frozen)
        &stream.token,
    );
    
    Ok(remaining)
}
```

### Part B: Reconcile & Audit (SDK Side)

```typescript
import { ReconciliationEngine } from '@fundable/sdk';

async function auditStreamBalance(
  contractId: string,
  streamId: string,
  onChainBalance: number,
  horizonServer: any,
  rpcUrl: string
) {
  const engine = new ReconciliationEngine(contractId, horizonServer, rpcUrl);
  
  // Step 1: Fetch all events from ledger
  const events = await engine.fetchStreamEvents(streamId);
  
  // Step 2: Reconstruct balance from events
  const stream = await engine.reconcileStream(streamId, onChainBalance);
  
  // Step 3: Check reconciliation status
  if (stream.reconciliationStatus === 'verified') {
    console.log('✅ Reconciliation passed!');
    console.log(`  Initial balance: ${stream.initialBalance}`);
    console.log(`  Total deposited: ${stream.totalDeposited}`);
    console.log(`  Total withdrawn: ${stream.totalWithdrawn}`);
    console.log(`  Current balance: ${stream.currentBalance}`);
  } else {
    console.error('❌ Reconciliation failed!');
    console.error(`  Details: ${stream.mismatchDetails}`);
  }
  
  // Step 4: Generate audit report
  const report = await engine.generateReconciliationReport(
    [streamId],
    new Map([[streamId, onChainBalance]])
  );
  
  // Step 5: Export for external auditors
  const auditJson = engine.exportForAudit(report);
  fs.writeFileSync('audit-report.json', auditJson);
}
```

### Verify Causality Chain

```typescript
async function verifyEventCausality(
  contractId: string,
  streamId: string,
  horizonServer: any,
  rpcUrl: string
) {
  const engine = new ReconciliationEngine(contractId, horizonServer, rpcUrl);
  
  // Fetch events
  const events = await engine.fetchStreamEvents(streamId);
  
  // Check for:
  // - Duplicate nonces (replay attacks)
  // - Out-of-order ledger sequences (tampering)
  // - Missing operations (incomplete history)
  const isValid = await engine.verifyCausality(events);
  
  if (isValid) {
    console.log('✅ Event chain is valid - no replays or tampering detected');
  } else {
    console.error('❌ Event chain validation failed!');
  }
  
  // Build causality map
  const chains = buildCausalityChain(events);
  for (const [nonce, events] of chains) {
    console.log(`Operation ${nonce}: ${events.length} events`);
  }
}
```

---

## Complete Example: Multi-Objective Workflow

```typescript
import { 
  TokenValidator, 
  ReconciliationEngine,
  buildAmountEventMetadata
} from '@fundable/sdk';

async function completeWorkflow(
  client: PaymentStreamClient,
  contractId: string,
  sender: string,
  recipient: string,
  tokenAddress: string,
  amountUSDC: number // e.g., 100.5
) {
  // 🎯 Objective 1: Track operation with nonce
  console.log('1️⃣  Creating operation nonce...');
  // (Handled automatically by contract via OperationNonce::from_env)
  
  // 🎯 Objective 2: Validate token decimals
  console.log('2️⃣  Validating token metadata...');
  const validator = new TokenValidator();
  const asset = validator.registerTokenAsset(
    tokenAddress, 6, 'USD Coin', 'U', 
    'GBUQ...', 'USDC'
  );
  
  // 🎯 Objective 3: Check fund authorization
  console.log('3️⃣  Checking fund authorization...');
  // (Authorization happens server-side based on policy)
  
  // 🎯 Objective 4: Create stream with event traceability
  console.log('4️⃣  Creating stream with full traceability...');
  const amountInNativeUnits = validator.toNativeUnits(
    tokenAddress, 
    amountUSDC
  );
  
  const tx = await client.createStream({
    recipient,
    token: tokenAddress,
    totalAmount: amountInNativeUnits.toString(),
    startTime: Math.floor(Date.now() / 1000),
    endTime: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  });
  
  const streamId = tx.streamId;
  
  // Later: Verify everything via reconciliation
  console.log('📊 Running reconciliation audit...');
  const engine = new ReconciliationEngine(contractId, horizonServer, rpcUrl);
  const stream = await engine.reconcileStream(streamId, amountInNativeUnits);
  
  console.log(`✅ All objectives satisfied:`);
  console.log(`  ✓ Operation tracked via nonce`);
  console.log(`  ✓ Token decimals frozen: ${asset.decimals}`);
  console.log(`  ✓ Fund authorization applied`);
  console.log(`  ✓ Full event traceability: ${stream.changes.length} events`);
}
```

---

## Troubleshooting

### "Decimal mismatch" error
```typescript
// ❌ Wrong: Token decimals changed after registration
validator.validateDecimals(tokenAddress, 8); // Was registered as 6

// ✅ Right: Always use registered decimals
const asset = validator.getTokenAsset(tokenAddress);
validator.validateDecimals(tokenAddress, asset.decimals);
```

### "Reconciliation mismatch" error
```typescript
// ❌ Check if event was missed
const events = await engine.fetchStreamEvents(streamId);
console.log(`Found ${events.length} events`);

// ✅ Verify all events are included in reconstruction
for (const event of events) {
  console.log(`  ${event.eventType}: ${event.amountChange}`);
}
```

### "Authorization denied" error
```rust
// ❌ Insufficient approvers
let approvers = vec![env.current_contract_address()];
withdraw_from_fund(&env, FundPurpose::Emergency, 1000, &recipient, approvers)?;
// Fails: Emergency requires multi-sig

// ✅ Provide all required approvers
let approvers = vec![admin1.clone(), admin2.clone()];
withdraw_from_fund(&env, FundPurpose::Emergency, 1000, &recipient, approvers)?;
// OK: 2 approvers provided
```

---

## Next Steps

1. **Test locally**: Run `npm test -- objectives.test.ts`
2. **Deploy to testnet**: Follow OBJECTIVES_IMPLEMENTATION_CHECKLIST.md
3. **Verify on ledger**: Use reconciliation engine to audit
4. **Monitor**: Set up alerts for reconciliation mismatches

---

For more details, see:
- `OBJECTIVES_IMPLEMENTATION.md` - Technical details
- `OBJECTIVES_CODE_EXAMPLES.md` - More code patterns
- `/workspaces/stellar_client_os/packages/sdk/src/__tests__/objectives.test.ts` - Full test suite
