# Local Development & Getting Started Guide

This document outlines the comprehensive setup path and development workflows for the `stellar_client` monorepo, which includes the Next.js frontend (`apps/web`), the TypeScript SDK (`packages/sdk`), and 15 Soroban smart contracts (`contracts/*`).

For a quick 5-minute setup checklist, see [QUICKSTART.md](../QUICKSTART.md).
For smart contract and service architecture details, see [docs/architecture.md](architecture.md).
For contract deployment, dry-run, and initialization, see [scripts/README.md](../scripts/README.md).

---

## 1. System Prerequisites & Versions

Before getting started, ensure your local environment satisfies the required tool versions:

| Tool | Version Requirement | Verification Command | Notes |
|------|---------------------|----------------------|-------|
| **Node.js** | `>= 18.0.0` (LTS 20.x or 22.x recommended) | `node -v` | Core JavaScript runtime |
| **pnpm** | `>= 8.0.0` (9.x or 10.x recommended) | `pnpm -v` | **Strict requirement.** Do NOT use `npm` or `yarn`. |
| **Rust** | `>= 1.75.0` | `rustc --version` | Rust compiler toolchain |
| **WASM Target** | `wasm32-unknown-unknown` | `rustup target list \| grep installed` | Target required for Soroban smart contracts |
| **Stellar CLI** | `25.0.0` | `stellar --version` | Soroban contract build/deploy CLI (`cargo install --locked stellar-cli@25.0.0`) |
| **Soroban SDK** | `25.3.2` | (Workspace lock) | Rust smart contracts workspace dependency |

> [!CAUTION]
> **Do NOT use `npm install` or `yarn`** — doing so will create a `package-lock.json` or `yarn.lock` file that conflicts with pnpm monorepo symlinks and will cause CI builds to fail.

---

## 2. Clean Environment Setup Path

Follow these steps to establish a clean development environment:

### Step 1: Clone the Repository
```bash
git clone https://github.com/Amiricloud1/stellar_client_os.git
cd stellar_client_os
```

**Expected Output:**
```text
Cloning into 'stellar_client_os'...
remote: Enumerating objects: ...
Resolving deltas: 100% ...
done.
```

### Step 2: Install Monorepo Dependencies
```bash
pnpm install
```

**Expected Output:**
```text
Lockfile is up to date, resolution step is skipped
Packages: +...
Progress: resolved ..., reused ..., downloaded 0, added ...
Done in ...s
```

### Step 3: Configure Environment
```bash
cp .env.example .env
```
Inspect `.env` to verify your target network configuration:
```env
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_STELLAR_RPC_URL=https://soroban-testnet.stellar.org
TESTNET_RPC_URL=https://soroban-testnet.stellar.org
TESTNET_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
NETWORK=testnet
```

### Step 4: Fund a Testnet Identity
Generate a local Stellar identity and fund it via Friendbot:
```bash
stellar keys generate fundable-dev --network testnet --fund
```
**Expected Output:**
```text
Created key fundable-dev with public key G...
Funded account G... with 10000.0000000 XLM via Friendbot
```

### Step 5: Build Soroban Contracts
Compile all 15 workspace contracts:
```bash
pnpm build:contracts
```
**Expected Output:**
```text
   Compiling soroban-sdk v25.3.2
   Compiling payment-stream v0.1.0 (/workspaces/stellar_client_os/contracts/payment-stream)
   Compiling distributor v0.1.0 (/workspaces/stellar_client_os/contracts/distributor)
   ...
   Finished release [optimized] target(s) in ...s
```

---

## 3. Daily Development Commands

### Web Application (`apps/web`)
- **Start dev server:** `pnpm dev` (Runs at `http://localhost:3000`)
- **Run unit & integration tests:** `pnpm --filter @fundable/web test`
- **Lint code:** `pnpm --filter @fundable/web lint`
- **Build production bundle:** `pnpm --filter @fundable/web build`

### TypeScript SDK (`packages/sdk`)
- **Run SDK tests:** `pnpm --filter @fundable/sdk test`
- **Run SDK coverage:** `pnpm --filter @fundable/sdk test:coverage`
- **Build SDK package:** `pnpm --filter @fundable/sdk build`

### Soroban Contracts (`contracts/*`)
- **Build all contracts:** `pnpm build:contracts`
- **Run contract tests:** `pnpm test:contracts` (or `cd contracts && cargo test`)

---

## 4. Monorepo Project Structure

```
stellar_client_os/
├── QUICKSTART.md              # Fast 5-minute setup checklist
├── README.md                  # Project introduction & high-level overview
├── apps/
│   └── web/                   # Next.js 15 frontend application
│       ├── src/
│       ├── package.json
│       └── ...
├── contracts/                 # 15 Soroban smart contracts (Rust workspace)
│   ├── payment-stream/        # Continuous token streaming
│   ├── distributor/           # Multi-recipient batch distributions
│   ├── nft-stream/            # Streaming milestone NFTs
│   ├── campaign-funding/      # Crowdfunding, escrow, and verification
│   ├── soulbound-badge/       # Non-transferable planter & donor credentials
│   ├── verifier-penalty/      # Verifier staking & slashing
│   ├── planter/               # Planter registry & metrics
│   ├── campaign-verification-audit/ # Immutable audit log
│   ├── dispute-arbiter/       # Multi-party arbitration engine
│   ├── timelock/              # Administrative delayed queue
│   ├── upgrade-proxy/         # Zero-downtime UUPS proxy
│   ├── sponsor-crowdfunding/  # Quadratic & matching pools
│   ├── sponsor-insurance/     # Forest mortality insurance
│   ├── campaign-diversity/    # Biodiversity scoring engine
│   ├── tax-deduction-certificate/ # Non-profit 501(c)(3) tax receipts
│   └── Cargo.toml             # Rust workspace definition (15 members)
├── deployments/               # Deployed contract IDs by network (testnet.json)
├── docs/                      # Architectural & integration documentation
│   ├── architecture.md        # 15-contract inventory, API & trust boundaries
│   ├── getting-started.md     # This comprehensive guide
│   ├── offramp-settlement-trust-boundaries.md # Settlement trust boundaries
│   └── ...
├── packages/
│   └── sdk/                   # TypeScript SDK for smart contracts
├── scripts/                   # Deployment, dry-run, and initialization scripts
│   ├── deploy.sh              # Multi-contract deployment script with dry-run
│   ├── initialize.sh          # Contract initialization script
│   └── README.md              # Deployment guide & runbooks
└── package.json               # Root monorepo workspace definition
```

---

## 5. Troubleshooting Reference

### Issue: `package-lock.json` or `yarn.lock` conflicts
- **Root Cause:** A package was installed using `npm` or `yarn`.
- **Resolution:**
  ```bash
  rm -f package-lock.json yarn.lock
  pnpm install
  ```

### Issue: Rust target `wasm32-unknown-unknown` not found
- **Root Cause:** The WebAssembly compiler target is not registered in rustup.
- **Resolution:**
  ```bash
  rustup target add wasm32-unknown-unknown
  ```

### Issue: Stellar Friendbot rate limiting
- **Root Cause:** SDF Friendbot is rate-limiting repeated key generation calls.
- **Resolution:** Wait 30 seconds before retrying, or fund your public key manually through the [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=test).

### Issue: Port 3000 already occupied
- **Root Cause:** Another server instance is active.
- **Resolution:** Specify an alternate port:
  ```bash
  pnpm --filter @fundable/web dev -- -p 3001
  ```

### Issue: `stellar-cli` version mismatch
- **Root Cause:** A newer or older version of `stellar-cli` is producing conflicting XDR envelopes.
- **Resolution:** Ensure version 25.0.0 is installed:
  ```bash
  cargo install --locked stellar-cli@25.0.0
  ```

---

## 6. Documentation Cross-Links
- [QUICKSTART.md](../QUICKSTART.md) — 5-minute setup checklist.
- [docs/architecture.md](architecture.md) — 15-contract inventory, API boundaries, and trust model.
- [scripts/README.md](../scripts/README.md) — Contract deployment and initialization runbook.
- [docs/offramp-settlement-trust-boundaries.md](offramp-settlement-trust-boundaries.md) — Offramp settlement security and trust boundaries.