# Quickstart Guide — Fundable Stellar

Get the Fundable Stellar monorepo (Next.js web client, TypeScript SDK, and 15 Soroban smart contracts) running locally on the Stellar Testnet in under 10 minutes.

For in-depth developer workflows and architectural details, see [docs/getting-started.md](docs/getting-started.md) and [docs/architecture.md](docs/architecture.md).

---

## 📋 Prerequisites & Tool Versions

Ensure your development environment meets the exact required versions:

| Tool | Version Requirement | Verification Command | Notes |
|------|---------------------|----------------------|-------|
| **Node.js** | `>= 18.0.0` (LTS 20.x or 22.x recommended) | `node -v` | JavaScript runtime |
| **pnpm** | `>= 8.0.0` (9.x or 10.x recommended) | `pnpm -v` | **Strict requirement.** Do NOT use `npm` or `yarn`. |
| **Rust** | `>= 1.75.0` | `rustc --version` | Rust toolchain with `wasm32` target |
| **WASM Target** | `wasm32-unknown-unknown` | `rustup target list \| grep installed` | Installed via `rustup target add wasm32-unknown-unknown` |
| **Stellar CLI** | `25.0.0` | `stellar --version` | Soroban CLI (`cargo install --locked stellar-cli@25.0.0`) |
| **Soroban SDK** | `25.3.2` | (Workspace lock) | Rust smart contracts workspace dependency |

> [!CAUTION]
> **Never run `npm install` or `yarn install`** in this monorepo. Doing so generates `package-lock.json` or `yarn.lock`, which corrupts the pnpm workspace linking and breaks CI.

---

## 🚀 Step-by-Step Setup

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

---

### Step 2: Install Workspace Dependencies

Use `pnpm` exclusively to install all workspace dependencies across `apps/web` and `packages/sdk`:

```bash
pnpm install
```

**Expected Output:**
```text
Lockfile is up to date, resolution step is skipped
Packages: +...
...
Progress: resolved ..., reused ..., downloaded 0, added ...
Done in ...s
```

---

### Step 3: Configure Environment Variables

Copy the provided environment template into `.env`:

```bash
cp .env.example .env
```

Key environment settings for testnet:
```env
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_STELLAR_RPC_URL=https://soroban-testnet.stellar.org
TESTNET_RPC_URL=https://soroban-testnet.stellar.org
TESTNET_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
NETWORK=testnet
```

---

### Step 4: Generate and Fund a Testnet Stellar Account

Generate a keypair and fund it with test XLM using Stellar Friendbot:

```bash
stellar keys generate fundable-dev --network testnet --fund
```

**Expected Output:**
```text
Created key fundable-dev with public key G...
Funded account G... with 10000.0000000 XLM via Friendbot
```

Retrieve the secret key and update `STELLAR_SECRET_KEY` in `.env`:
```bash
stellar keys show fundable-dev
```

---

### Step 5: Build Soroban Smart Contracts

Build all 15 workspace contracts targeting WebAssembly:

```bash
pnpm build:contracts
```
*(Or navigate to contracts: `cd contracts && cargo build --release --target wasm32-unknown-unknown`)*

**Expected Output:**
```text
   Compiling soroban-sdk v25.3.2
   Compiling payment-stream v0.1.0 (/workspaces/stellar_client_os/contracts/payment-stream)
   Compiling distributor v0.1.0 (/workspaces/stellar_client_os/contracts/distributor)
   ...
   Finished release [optimized] target(s) in ...s
```
Compiled `.wasm` artifacts are saved in `contracts/target/wasm32-unknown-unknown/release/`.

---

### Step 6: Verify Tests

Run the test suite across the monorepo:

```bash
# Run Web application tests
pnpm --filter @fundable/web test

# Run SDK unit tests
pnpm --filter @fundable/sdk test
```

**Expected Output:**
```text
Test Files  ... passed
Tests       ... passed
Duration    ...s
```

---

### Step 7: Launch the Local Frontend

Start the Next.js development server:

```bash
pnpm dev
```

**Expected Output:**
```text
  ▲ Next.js 15.x.x
  - Local:        http://localhost:3000
  - Network:      http://...:3000

 ✓ Starting...
 ✓ Ready in 1.8s
```

Open [http://localhost:3000](http://localhost:3000) in your browser. Connect a Stellar wallet (e.g., Freighter configured to Testnet) to interact with the platform.

---

## 🔁 Verifying Reproducible Contract Builds

Contract artifacts must be byte-for-byte reproducible so that on-chain deployments can be independently verified. The build is performed twice in clean, pinned environments and the **normalized** wasm hashes are compared.

### Run the verification

```bash
# From the repo root — builds twice in clean dirs and compares normalized hashes
pnpm verify:reproducible-builds
```

*(Equivalent manual flow: `cd contracts && cargo clean && cargo build --release --target wasm32-unknown-unknown`, copy artifacts aside, repeat, then compare normalized hashes.)*

**Expected Output (success):**
```text
[reproducible] build #1 -> 15 artifacts
[reproducible] build #2 -> 15 artifacts
[reproducible] payment-stream.wasm  OK  sha256=<hash>
[reproducible] distributor.wasm     OK  sha256=<hash>
...
[reproducible] All 15 contracts reproducible ✅
```

**Expected Output (failure):**
```text
[reproducible] distributor.wasm  MISMATCH
  build #1 sha256=<hash-a>
  build #2 sha256=<hash-b>
[reproducible] 1 of 15 contracts are NOT reproducible ❌
```

### What is normalized before hashing

To avoid false mismatches, the following legitimate nondeterministic metadata is stripped/normalized before hashing:

- **Build paths** — absolute workspace paths embedded in the `name`/producers custom sections are rewritten to a stable placeholder.
- **Timestamps** — any build-time timestamp metadata is zeroed out.
- **Custom `producers` section ordering** — entries are sorted deterministically.

Everything else (code, data, and type sections) must match exactly. If a mismatch persists after normalization, it indicates a genuine nondeterminism (e.g. differing dependency versions, uncommitted source, or a non-pinned toolchain) — check `rust-toolchain.toml` and `Cargo.lock` are committed and unchanged.

> [!NOTE]
> Reproducible-build verification is deterministic and runs entirely offline — it does not touch live funds or the network. CI runs it on every contracts change (see `.github/workflows/contracts.yml`).

---

## 🛠️ Common Troubleshooting & Solutions

### 1. `package-lock.json` or `yarn.lock` Detected
- **Symptom:** Git status shows an untracked `package-lock.json` or CI fails during dependency check.
- **Cause:** Running `npm install` or `yarn` instead of `pnpm install`.
- **Solution:**
  ```bash
  rm -f package-lock.json yarn.lock
  pnpm install
  ```

### 2. Missing `wasm32-unknown-unknown` Rust Target
- **Symptom:** `error[E0463]: can't find crate for 'core'` or `target 'wasm32-unknown-unknown' not found`.
- **Cause:** Rust wasm compilation target is not installed in your toolchain.
- **Solution:**
  ```bash
  rustup target add wasm32-unknown-unknown
  ```

### 3. Friendbot Rate Limit or Network Timeout
- **Symptom:** `stellar keys generate ... --fund` hangs or fails with HTTP 429/504.
- **Cause:** Stellar SDF testnet Friendbot transient rate limiting.
- **Solution:** Retry after 30 seconds, or manually fund your public key via the [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=test).

### 4. Port 3000 Already in Use
- **Symptom:** `Error: listen EADDRINUSE: address already in use :::3000`.
- **Cause:** Another process or development server is using port 3000.
- **Solution:** Start on a different port:
  ```bash
  pnpm --filter @fundable/web dev -- -p 3001
  ```

### 5. `stellar-cli` Version Incompatibility
- **Symptom:** Unrecognized command flags or RPC envelope mismatches.
- **Cause:** Using an incompatible version of Stellar CLI.
- **Solution:** Install the tested version:
  ```bash
  cargo install --locked stellar-cli@25.0.0
  ```

### 6. Reproducible Build Mismatch
- **Symptom:** `verify:reproducible-builds` reports `MISMATCH` for one or more contracts.
- **Cause:** Non-pinned toolchain, modified `Cargo.lock`, uncommitted source, or a genuine nondeterminism not covered by normalization.
- **Solution:** Ensure `rust-toolchain.toml` and `Cargo.lock` are committed and unchanged, run `cargo clean`, and re-run the verification. If it still fails, inspect the diff of the two artifacts to identify the offending section.

---

## 🔗 Related Documentation
- [docs/getting-started.md](docs/getting-started.md) — Comprehensive local development setup and commands.
- [docs/architecture.md](docs/architecture.md) — 15-contract inventory, API boundaries, trust boundaries, and data flows.
- [scripts/README.md](scripts/README.md) — Contract deployment, dry-run simulation, and verification guide.
- [docs/offramp-settlement-trust-boundaries.md](docs/offramp-settlement-trust-boundaries.md) — Settlement and bridge trust boundaries specification.
