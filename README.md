# Fundable Stellar

## 🚀 Quickstart (5 Minutes)

Get the Fundable Stellar client running on the Stellar testnet in about five minutes.

### Prerequisites

- [Node.js](https://nodejs.org) v18+
- [pnpm](https://pnpm.io) v8+ (`npm install -g pnpm`)
- [Rust](https://rustup.rs) (for building the Soroban contracts)
- [Soroban CLI / stellar-cli](https://soroban.stellar.org/docs/getting-started/setup) v25.0.0+

  ```bash
  cargo install --locked stellar-cli@25.0.0
  ```

### 1. Clone the repository

```bash
git clone https://github.com/Fundable-Protocol/stellar_client_os.git
cd stellar_client_os
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Fund a Stellar testnet account

Create a testnet identity and fund it with test XLM using Friendbot:

```bash
stellar keys generate my-account --network testnet --fund
```

This creates a keypair and funds it instantly on the SDF testnet. Copy the generated secret key into your environment:

```bash
cp .env.example .env
# Set STELLAR_SECRET_KEY in .env to the secret printed above
```

### 4. Build the smart contracts

```bash
pnpm build:contracts
# or, using cargo directly:
# cd contracts && cargo build --release
```

### 5. Run the frontend

```bash
pnpm dev
```

The web app starts at http://localhost:3000. Connect a wallet (e.g. Freighter) to interact with the contracts on testnet.

> For the unified setup guide, step-by-step outputs, and troubleshooting, see [QUICKSTART.md](QUICKSTART.md) and [docs/getting-started.md](docs/getting-started.md).  
> For the 15-contract inventory and trust boundaries, see [docs/architecture.md](docs/architecture.md).

Stellar client and smart contracts for the Fundable Protocol – a decentralized payment platform enabling seamless Web3 payments, streaming, and subscriptions on the Stellar blockchain.

## 🏗️ Project Structure

```
stellar_client/
├── apps/
│   └── web/                 # Next.js frontend application
│       ├── src/
│       ├── package.json
│       └── ...
│
├── contracts/               # Soroban smart contracts (Rust)
│   ├── payment-stream/      # Payment streaming contract
│   ├── distributor/         # Token distribution contract
│   ├── campaign-funding/    # Campaign escrow & funding contract
│   ├── campaign-verification-audit/ # Immutable on-chain verification audit log
│   ├── planter/             # Planter performance & metrics contract
│   └── Cargo.toml           # Rust workspace config
│
├── docs/                      # Project documentation
│   ├── architecture.md
│   ├── getting-started.md     # Project setup documentation
│   ├── webhooks.md            # Webhook system documentation
│   ├── openapi.yaml           # OpenAPI specification
│   ├── rate-limits.md         # API rate limiting documentation
│   ├── contracts/             # Contracts documentation
│   │   ├── distributor.md
│   │   └── payment-stream.md
│   └── frontend/              # Frontend documentation
│       └── components.md
├── packages/                  # Monorepo packages
│   └── sdk/                   # TypeScript SDK for contract interaction
│
└── package.json             # Root workspace config


```

## 🌟 Features

- **Payment Streaming** - Create and manage continuous token streams
- **Token Distribution** - Efficiently distribute tokens to multiple recipients
- **Campaign Funding** - Launch and manage on-chain fundraising campaigns with milestones
- **Multi-Asset Support** - USDC, XLM, and other Stellar assets
- **Campaign Milestone Push Notifications** - Real-time mobile push updates for trees planted, verification complete, campaign finished, and impact achieved
- **Campaign Verification Audit Trail** - Immutable blockchain log of all verification activities (submitted for review, verifier comments, photo uploaded, approved/rejected)
- **Offramp Integration** - Convert crypto to fiat currencies

## 🛠️ Tech Stack

| Component | Technology |
|-----------|------------|
| **Frontend** | Next.js 16, React 19, TypeScript, Tailwind CSS v4 |
| **Contracts** | Soroban SDK, Rust |
| **SDK** | TypeScript, @stellar/stellar-sdk |

## 📐 Campaign Contract Architecture

The `contracts/campaign` Soroban contract powers on-chain fundraising campaigns.

### State Machine

Campaigns progress through `Draft -> Active -> Paused -> Successful/Failed -> PaidOut/Refunded`.

- `Draft` – creator configures campaign and milestone payout schedule.
- `Active` – contributions are accepted.
- `Paused` – emergency stop; contributions suspended but state preserved.
- `Successful` – all milestones verified and claimed by the creator.
- `Failed` – end time reached without meeting the funding goal or cancelled by admin.
- `PaidOut` – final milestone released and campaign fully settled.
- `Refunded` – backers can claim proportional refunds after failure.

Transitions are enforced by the contract and only the `admin` or `campaign_owner` may invoke restricted actions.

### Security Model

- **Admin guard**: privileged operations use an `admin` address set at deployment.
- **Capability checks**: every state transition validates caller and current state.
- **Reentrancy protection**: external calls to token contracts happen after internal state updates.
- **Overflow-safe math**: checked arithmetic from the Soroban SDK prevents balance errors.
- **Escrow accounting**: contributions are held in contract balance and only released by explicit `payout` or `refund` functions.
- **Milestone approvals**: fund release requires multi-sig/approval from designated reviewers before owner can claim.

### Scalability

- Campaigns are stored as persistent map entries keyed by `u32` campaign id, avoiding unbounded collections.
- Contributions are aggregated rather than stored as individual ledger entries.
- Payouts batch milestone claims to minimize transaction count.
- The contract is stateless with respect to off-chain indexers; event log entries enable efficient data replication.
- Deployment uses a single contract with per-campaign storage, allowing the same contract ID to serve many campaigns without migrations.

## 🚀 Getting Started

### Prerequisites

- Node.js v18+
- pnpm v8+
- Rust (for contracts)
- [Soroban CLI](https://soroban.stellar.org/docs/getting-started/setup)

### Installation

```bash
# Clone the repository
git clone git@github.com:Fundable-Protocol/stellar_client.git
cd stellar_client

# Install frontend dependencies
pnpm install

# Build contracts
cd contracts && cargo build --release
```

### Development

```bash
# Start the web app
pnpm dev

# Build contracts
pnpm build:contracts

# Run contract tests
pnpm test:contracts
```

### Contract Artifact Builds

`pnpm build:contracts` derives the deployable contract set directly from the
Cargo workspace members declared in `contracts/Cargo.toml` — there is no
hardcoded two-contract list. Every workspace member that produces a deployable
wasm is built and its artifact is verified.

The build **fails** when:

- a deployable workspace member is omitted from the artifact set, or
- a deployable member's `.wasm` artifact is missing after the build.

When you add a new contract crate to the workspace, it is picked up
automatically; no build-script edit is required. If a member is intentionally
non-deployable (e.g. a shared library crate), mark it as such in the workspace
metadata so the build does not expect a wasm for it.

## 💡 Usage Examples

### 🌌 Horizon Client (Classic Stellar)

The Horizon client is used for interacting with the classic Stellar network, such as fetching account details, balances, and transaction history.

```typescript
import { Horizon } from '@stellar/stellar-sdk';

const server = new Horizon.Server('https://horizon-testnet.stellar.org');

// Fetch account details and balances
async function checkAccount(address: string) {
  try {
    const account = await server.loadAccount(address);
    console.log(`Account ID: ${account.id}`);
    
    account.balances.forEach(balance => {
      console.log(`Type: ${balance.asset_type}, Balance: ${balance.balance}`);
    });
  } catch (error) {
    console.error('Error loading account:', error);
  }
}

checkAccount('GBBB...');
```

### ⚡ Soroban Client (Smart Contracts)

Use the `@fundable/sdk` to interact with Fundable smart contracts on the Soroban network. This example shows how to initialize the `PaymentStreamClient` and create a new payment stream.

```typescript
import { PaymentStreamClient, signAndWait } from '@fundable/sdk';

const client = new PaymentStreamClient({
  contractId: 'C...', // Deployed contract ID
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
});

async function createNewStream() {
  // 1. Prepare the stream creation transaction
  const tx = a

/* … truncated 5660 chars — edit only what you need near the top … */
