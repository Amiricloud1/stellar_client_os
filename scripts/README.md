# Smart Contract Deployment & Initialization Guide

This guide details the deployment, dry-run simulation, initialization, verification, and recovery runbooks for all 15 Soroban smart contracts in the Fundable Stellar platform.

---

## 1. Supported Contract Inventory (15 Contracts)

Every contract in the `contracts/` workspace compiles into a dedicated `.wasm` binary in `contracts/target/wasm32-unknown-unknown/release/`.

| # | Workspace Member | Crate Name | WASM Artifact | Initialization Function & Parameters |
|---|------------------|------------|---------------|--------------------------------------|
| 1 | `payment-stream` | `payment-stream` | `payment_stream.wasm` | `initialize(admin, fee_collector, general_fee_rate)` |
| 2 | `distributor` | `distributor` | `distributor.wasm` | `initialize(admin, protocol_fee_percent, fee_address)` |
| 3 | `nft-stream` | `nft-stream` | `nft_stream.wasm` | `initialize(admin)` |
| 4 | `campaign-funding` | `campaign-funding` | `campaign_funding.wasm` | Instance ready; per-campaign escrow init (`initialize_campaign_escrow`) |
| 5 | `soulbound-badge` | `soulbound-badge` | `soulbound_badge.wasm` | `initialize(admin, accepted_token)` |
| 6 | `verifier-penalty` | `stellar-client-os-verifier-penalty` | `stellar_client_os_verifier_penalty.wasm` | `initialize(admin)` |
| 7 | `planter` | `planter` | `planter.wasm` | `initialize(admin, reward_token, reward_amount)` |
| 8 | `campaign-verification-audit` | `campaign-verification-audit` | `campaign_verification_audit.wasm` | `initialize(admin)` |
| 9 | `dispute-arbiter` | `stellar-client-os-dispute-arbiter` | `stellar_client_os_dispute_arbiter.wasm` | `initialize(admin)` |
| 10 | `timelock` | `timelock` | `timelock.wasm` | `initialize(admin)` |
| 11 | `upgrade-proxy` | `upgrade-proxy` | `upgrade_proxy.wasm` | `initialize(admin, implementation_hash)` |
| 12 | `sponsor-crowdfunding` | `sponsor-crowdfunding` | `sponsor_crowdfunding.wasm` | `initialize(admin)` |
| 13 | `sponsor-insurance` | `sponsor-insurance` | `sponsor_insurance.wasm` | `initialize(admin)` |
| 14 | `campaign-diversity` | `campaign-diversity` | `campaign_diversity.wasm` | `initialize(admin, registrar)` |
| 15 | `tax-deduction-certificate` | `tax-deduction-certificate` | `tax_deduction_certificate.wasm` | `initialize(admin)` |

---

## 2. Prerequisites & Environment Configuration

### Required Tooling
1. **Stellar CLI:**
   ```bash
   cargo install --locked stellar-cli@25.0.0
   stellar --version # Expected: 25.0.0
   ```
2. **Rust & Wasm Compiler Target:**
   ```bash
   rustup target add wasm32-unknown-unknown
   ```
3. **JSON Parser (`jq`):**
   ```bash
   sudo apt-get install jq # or brew install jq
   ```

### Environment Configuration
Copy `.env.example` to `.env` and configure:
```env
NETWORK=testnet
TESTNET_RPC_URL=https://soroban-testnet.stellar.org
TESTNET_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
STELLAR_SECRET_KEY=S... # Deployer secret key
STELLAR_ACCOUNT_ADDRESS=G... # Deployer public key (admin)
```

Generate and fund a testnet keypair:
```bash
stellar keys generate fundable-deployer --network testnet --fund
```

---

## 3. Dry-Run Simulation

Always perform a dry-run before live deployment. Dry-run mode validates prerequisites, checks WASM target paths, predicts contract IDs, and simulates gas without spending live network funds.

### Dry-Run All Contracts
```bash
./scripts/deploy.sh --dry-run
# or
DRY_RUN=true ./scripts/deploy.sh
```

### Dry-Run a Single Contract
```bash
./scripts/deploy.sh nft-stream --dry-run
```

**Sample Output:**
```text
========================================================
 Fundable Stellar Contract Deployer
 Network:      testnet
 Dry Run:      true
 Target:       nft-stream
 Deployments:  deployments/testnet.json
========================================================

--- Processing: nft-stream (nft_stream.wasm) ---
🧪 [DRY-RUN] Prerequisite checks passed.
🧪 [DRY-RUN] Target artifact: contracts/target/wasm32-unknown-unknown/release/nft_stream.wasm
🧪 [DRY-RUN] Simulated gas estimate: ~1,500,000 instructions
🧪 [DRY-RUN] Predicted contract ID: C844E37D66B1FC4AD3246D68D1CE2B68D5502B4689403380CE2AF5D2
```

Simulate initialization in dry-run mode:
```bash
./scripts/initialize.sh --dry-run
```

---

## 4. Live Deployment

### Step 1: Build Smart Contracts
Compile all contracts in release mode for WebAssembly:
```bash
cd contracts
cargo build --release --target wasm32-unknown-unknown
cd ..
```

### Step 2: Deploy Contracts
Execute `deploy.sh` to deploy un-deployed contracts to the configured network:
```bash
./scripts/deploy.sh
```

To selectively deploy a specific contract:
```bash
./scripts/deploy.sh payment-stream
```

To force re-deployment of an already deployed contract:
```bash
./scripts/deploy.sh payment-stream --force
```

Deployed addresses are saved atomically in `deployments/${NETWORK}.json`:
```json
{
  "payment_stream": "CA3DIUFFHMAWENXSH2NBI7OVOQ7MU6LZMKHRV5ABWGIT24IUG3QKGIJX",
  "distributor": "CBX5CH2GDKOXXCHTR6OSPYM3HZX3PP2GJI7FYGGHREA232D2F7WV75IH"
}
```

---

## 5. Contract Initialization

Initialize the deployed contracts using `initialize.sh`:

```bash
# Initialize all deployed contracts
./scripts/initialize.sh

# Or initialize a specific contract
./scripts/initialize.sh payment-stream
```

The script automatically maps the required argument schema for each contract. If a contract has already been initialized, the script handles the `AlreadyInitialized` exception idempotently and continues with remaining contracts.

---

## 6. Verification

Verify deployment and initialization on-chain:

### 1. View Local Deployment Records
```bash
cat deployments/testnet.json
```

### 2. Query On-Chain Contract Info via Stellar CLI
```bash
stellar contract inspect --id <CONTRACT_ID> --network testnet
```

### 3. Verify Contract Read Methods
```bash
# Example: Query general fee rate on payment-stream
stellar contract invoke \
  --id <PAYMENT_STREAM_ID> \
  --network testnet \
  -- \
  get_general_fee_rate
```

### 4. Verify in Stellar Explorer
View transaction history, events, and contract storage on the public explorer:
`https://stellar.expert/explorer/testnet/contract/<CONTRACT_ID>`

---

## 7. Recovery & Troubleshooting Runbook

### Scenario A: Deployment Interrupted Midway
- **Problem:** Network connection dropped or RPC timed out while deploying contract 7 of 15.
- **Recovery:** Simply re-run `./scripts/deploy.sh`. The script checks `deployments/${NETWORK}.json`, detects contracts 1 through 6 are already deployed, and resumes deployment starting from contract 7.

### Scenario B: Force Redeploy a Specific Contract
- **Problem:** A contract bug was fixed and only that single contract needs a fresh deployment.
- **Recovery:**
  ```bash
  FORCE_DEPLOY=true ./scripts/deploy.sh <contract_name>
  ```
  The script deploys the new WASM binary and updates `deployments/${NETWORK}.json` with the new Contract ID.

### Scenario C: Contract Initialization Fails
- **Problem:** Script reports `HostError` or `AlreadyInitialized`.
- **Diagnosis:** A contract can only be initialized once in its lifecycle.
- **Recovery:** If already initialized, no recovery is needed. If failed due to parameter mismatch, inspect contract source in `contracts/<name>/src/lib.rs` to verify parameter count and types.

### Scenario D: Zero-Downtime Contract Logic Upgrade
- **Problem:** Updating contract logic without changing the deployed address or clearing storage.
- **Recovery:**
  1. Upload the new WASM blob:
     ```bash
     NEW_HASH=$(stellar contract install --wasm <NEW_WASM_PATH> --source "$STELLAR_SECRET_KEY" --network testnet)
     ```
  2. Invoke `upgrade` on `upgrade-proxy`:
     ```bash
     stellar contract invoke \
       --id <PROXY_ID> \
       --network testnet \
       --source "$STELLAR_SECRET_KEY" \
       -- \
       upgrade \
       --new_wasm_hash "$NEW_HASH"
     ```