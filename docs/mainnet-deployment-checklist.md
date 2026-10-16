# Mainnet Deployment Readiness and Approval Checklist

> **Scope:** This checklist MUST be completed in full—and signed off by two authorized personnel—before any irreversible action is taken on mainnet (WASM upload, contract instantiation, admin transfer, or upgrade).
>
> **Policy:** Incomplete or unsigned checklists block the deploy pipeline. The `scripts/deploy.sh` script reads `deployments/mainnet.json` only after this checklist has been committed and reviewed.

---

## 1. Pre-Deployment Artifact Verification

All artifacts must match the values recorded in `deployments/manifest.json` (see `docs/deployment-manifest.md`).

| # | Check | Who | Status | Notes |
|---|-------|-----|--------|-------|
| 1.1 | WASM file exists at the expected path (`contracts/target/wasm32-unknown-unknown/release/*.wasm`) | Deployer | ☐ | Path: |
| 1.2 | WASM SHA-256 hash matches `deployments/manifest.json::wasmHash` | Deployer | ☐ | Hash: |
| 1.3 | WASM binary was built from the tagged release commit (`git tag`) | Reviewer | ☐ | Tag: |
| 1.4 | Build is reproducible: re-running `cargo build --release --target wasm32-unknown-unknown` produces the same hash | Reviewer | ☐ | |
| 1.5 | Contract version in `Cargo.toml` matches the planned release version | Deployer | ☐ | Version: |

---

## 2. Admin Custody and Key Management

| # | Check | Who | Status | Notes |
|---|-------|-----|--------|-------|
| 2.1 | Admin keypair (`STELLAR_SECRET_KEY`) is stored in a hardware security module (HSM) or equivalent | Security | ☐ | |
| 2.2 | Admin secret key has **not** been logged, committed to source control, or shared via insecure channels | Security | ☐ | |
| 2.3 | Admin public address (`G…`) matches the address in `deployments/manifest.json::deployer` | Deployer | ☐ | Address: |
| 2.4 | Admin account has sufficient XLM balance for fees and minimum reserve (`≥ 2 XLM + fee buffer`) | Deployer | ☐ | Balance: |
| 2.5 | Backup admin keypair exists and is stored independently of the primary | Security | ☐ | |
| 2.6 | Multi-sig threshold is set if required by governance policy | Security | ☐ | Threshold: |

---

## 3. Network Passphrase Verification

| # | Check | Who | Status | Notes |
|---|-------|-----|--------|-------|
| 3.1 | `NETWORK_PASSPHRASE` env var is set to the Stellar **mainnet** passphrase: `Public Global Stellar Network ; September 2015` | Deployer | ☐ | |
| 3.2 | RPC endpoint (`STELLAR_RPC_URL`) resolves to a **mainnet** Horizon/RPC node | Deployer | ☐ | URL: |
| 3.3 | `stellar network show` output confirms `network: mainnet` | Deployer | ☐ | |
| 3.4 | `deploy.sh` variable `NETWORK_PARAPHRASE` resolves to the mainnet passphrase (not testnet) | Reviewer | ☐ | |
| 3.5 | A dry-run (`--dry-run` flag or offline signing) was performed and confirmed the correct network passphrase in XDR | Reviewer | ☐ | |

---

## 4. Contract Initialization Checks

| # | Check | Who | Status | Notes |
|---|-------|-----|--------|-------|
| 4.1 | `initialize.sh` has been tested on testnet with identical parameters | Deployer | ☐ | Testnet tx: |
| 4.2 | `initialize` call parameters have been reviewed and match governance-approved values | Reviewer | ☐ | |
| 4.3 | The `initialize` function is **not** callable more than once (re-initialization guard confirmed in contract code) | Reviewer | ☐ | |
| 4.4 | Contract ID from deploy step recorded in `deployments/mainnet.json` before calling `initialize` | Deployer | ☐ | Contract ID: |
| 4.5 | Post-initialization state read back via `stellar contract invoke … -- get_admin` confirms correct admin | Deployer | ☐ | |
| 4.6 | Token addresses (if any) passed to `initialize` are valid mainnet asset contracts | Reviewer | ☐ | |

---

## 5. Monitoring and Observability

| # | Check | Who | Status | Notes |
|---|-------|-----|--------|-------|
| 5.1 | Soroban event indexer (`scripts/cdc-indexer.ts`) is configured for mainnet and running | Ops | ☐ | |
| 5.2 | TTL renewal bot (`scripts/ttl-renewal-bot.ts`) is configured with the mainnet contract ID | Ops | ☐ | |
| 5.3 | Alerts are configured for contract invocation failures and unexpected state changes | Ops | ☐ | |
| 5.4 | A rollback or upgrade path has been documented and is operationally available | Ops | ☐ | See: |
| 5.5 | A post-deploy monitoring window of ≥ 1 hour is scheduled with on-call personnel | Ops | ☐ | On-call: |
| 5.6 | Deployment transaction hash(es) recorded for audit trail | Ops | ☐ | TX hash: |

---

## 6. Two-Person Approval

All sections above must be ☑ before signing. Signing constitutes authorization to proceed with irreversible mainnet actions.

| Role | Name | GitHub Username | Signature | Date (UTC) |
|------|------|----------------|-----------|-----------|
| Primary Deployer | | | | |
| Secondary Reviewer | | | | |

> **⚠ CRITICAL:** If any check above cannot be completed, the deployment MUST be halted. Do not proceed under time pressure. Raise a blocker in the relevant GitHub issue/PR.

---

## 7. Post-Deployment Verification

Complete these steps immediately after deployment.

| # | Check | Who | Status | Notes |
|---|-------|-----|--------|-------|
| 7.1 | Contract ID recorded in `deployments/mainnet.json` and committed to main branch | Deployer | ☐ | Commit: |
| 7.2 | `deployments/manifest.json` updated with actual ledger number and deploy tx hash | Deployer | ☐ | Ledger: |
| 7.3 | SDK `generate:mainnet` script run and output reviewed for correctness | Deployer | ☐ | |
| 7.4 | At least one end-to-end read-only invocation confirmed on mainnet | Reviewer | ☐ | |
| 7.5 | Relevant stakeholders notified of successful deployment | Deployer | ☐ | |

---

## Reference

- [Deployment Manifest Schema](./deployment-manifest.md)
- [SDK Recipes](./sdk/recipes.md)
- [OpenAPI Reference](./api-reference.md)
- Deployment scripts: [`scripts/deploy.sh`](../scripts/deploy.sh), [`scripts/initialize.sh`](../scripts/initialize.sh)
- Mainnet deployment record: [`deployments/mainnet.json`](../deployments/mainnet.json)
