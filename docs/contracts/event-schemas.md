# Soroban Contract Event Schemas and Versioning

This document specifies the event topics, payloads, versioning policy, and SDK validation standards for all smart contracts in the Fundable Stellar ecosystem.

---

## 1. Event Versioning & Compatibility Policy

Contract events represent public API commitments to indexers, frontends, and external analytic services. To prevent breaking downstream consumers, the following evolution rules are enforced:

1. **Semantic Versioning per Event**: Each event schema is tagged with a monotonically increasing integer version (`v1`, `v2`, ...).
2. **Backward-Compatible Evolutions (Minor/Patch)**:
   - Topic structure and positions must remain constant.
   - Any new payload fields must be optional or provide fallback defaults.
   - Existing fields must not be renamed or change their scalar/XDR representations.
3. **Breaking Schema Changes (Major)**:
   - When required fields must be removed or topic structures changed, the event must be emitted under a new name or bumped version with a documented deprecation grace period.
4. **SDK Validation**: The SDK's `event-validator.ts` provides validation helpers and runtime compatibility checks (`assertBackwardCompatibility`) for all ingested events.

---

## 2. Core Contract Event Specifications

### 2.1 Payment Stream Contract (`contracts/payment-stream`)

#### `FeeCollected` (v1)
Emitted whenever a protocol fee is collected upon withdrawal or settlement.
- **Topics**: `["FeeCollected"]`
- **Payload**:
  | Field | Type | Description |
  |---|---|---|
  | `stream_id` | `u64` | Identifier of the payment stream |
  | `recipient` | `Address` | Protocol fee recipient address |
  | `amount` | `i128` | Fee amount in token base units |
  | `timestamp` | `u64` | Ledger timestamp of fee deduction |

#### `StreamDeposit` (v1)
Emitted when an account tops up or deposits into an existing stream.
- **Topics**: `["StreamDeposit"]`
- **Payload**:
  | Field | Type | Description |
  |---|---|---|
  | `stream_id` | `u64` | Stream ID receiving funds |
  | `sender` | `Address` | Depositor address |
  | `amount` | `i128` | Amount deposited in token base units |

#### `StreamPaused` / `StreamResumed` (v1)
Emitted when stream flow is paused or resumed.
- **Topics**: `["StreamPaused"]` or `["StreamResumed"]`
- **Payload**:
  | Field | Type | Description |
  |---|---|---|
  | `stream_id` | `u64` | Target stream identifier |
  | `actor` | `Address` | Admin or stream owner executing state change |

---

### 2.2 Timelock Contract (`contracts/timelock`)

#### `ActionProposed` (v1)
Emitted when an authorized admin schedules an action with a 48-hour delay.
- **Topics**: `["ActionProposed"]`
- **Payload**:
  | Field | Type | Description |
  |---|---|---|
  | `admin` | `Address` | Proposing admin address |
  | `action_hash` | `BytesN<32>` | SHA-256 hash of the proposed WASM or call |
  | `target` | `Option<Address>` | Target contract address (if cross-contract) |
  | `description` | `String` | Human-readable explanation of the action |

#### `ActionExecuted` (v1)
Emitted upon execution of a timelocked action within the valid execution window.
- **Topics**: `["ActionExecuted"]`
- **Payload**:
  | Field | Type | Description |
  |---|---|---|
  | `admin` | `Address` | Executing admin address |
  | `action_hash` | `BytesN<32>` | Executed action hash |
  | `target` | `Option<Address>` | Target contract address |

#### `ActionCancelled` (v1)
Emitted when an admin cancels a pending action prior to execution.
- **Topics**: `["ActionCancelled"]`
- **Payload**:
  | Field | Type | Description |
  |---|---|---|
  | `admin` | `Address` | Cancelling admin address |
  | `action_hash` | `BytesN<32>` | Cancelled action hash |

---

### 2.3 Distributor Contract (`contracts/distributor`)

#### `DistributeBatch` (v1)
Emitted when token amounts are distributed across variable recipients.
- **Topics**: `["DistributeBatch"]`
- **Payload**:
  | Field | Type | Description |
  |---|---|---|
  | `token` | `Address` | Distributed SAC or SEP-41 token contract |
  | `sender` | `Address` | Funding sender address |
  | `recipient_count` | `u32` | Total number of recipient entries |
  | `total_amount` | `i128` | Aggregate token base units distributed |

---

## 3. SDK Event Parsing and Validation Usage

```typescript
import {
  getEventSchema,
  validateContractEvent,
  assertBackwardCompatibility,
} from '@fundable/sdk';

// 1. Fetch official schema
const schema = getEventSchema('timelock', 'ActionProposed', 1);

// 2. Validate ingested RPC event
const result = validateContractEvent(rawRpcEvent, schema);
if (!result.valid) {
  console.error('Event schema validation failed:', result.errors);
} else {
  console.log('Action hash:', result.parsedPayload.actionHash);
}
```
