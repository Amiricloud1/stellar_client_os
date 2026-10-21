# Dependency Update Automation & Security Policy

This document outlines the dependency update automation, lockfile validation, grouping rules, security prioritization, and exception policies for both JavaScript/TypeScript (`pnpm`) and Rust (`cargo`) ecosystems.

---

## 1. Automation Schedule & Grouping Strategy

Automated updates are configured via `.github/dependabot.yml` and scheduled weekly (Mondays at 04:00 UTC).

### 1.1 `pnpm` (Node.js & Web/SDK Workspace)
- **Stellar Ecosystem**: Dedicated group (`@stellar/*`) to keep Stellar SDK, Horizon client, and RPC libraries synchronized.
- **Production Dependencies**: Grouped updates for runtime libraries to avoid PR noise.
- **Development Dependencies**: Grouped updates for linters, formatters, and build tooling.

### 1.2 `Cargo` (Soroban Smart Contracts)
- **Soroban SDK Group**: Grouped updates for `soroban-sdk`, `soroban-spec`, and related framework dependencies.
- **Contract Dependencies**: Grouped updates for core Rust crates used in smart contract builds.

---

## 2. Lockfile Validation Standards

1. **Strict Lockfile Integrity**:
   - For `pnpm`: `pnpm install --frozen-lockfile` is enforced in CI. No PR may alter `package.json` without updating `pnpm-lock.yaml`.
   - For `Cargo`: `cargo check --locked` / `cargo test --locked` is enforced in CI. No PR may alter `Cargo.toml` without updating `Cargo.lock`.
2. **Zero Incompatible Mixups**:
   - `package-lock.json` and `yarn.lock` are strictly prohibited in the repository to prevent package manager collisions.

---

## 3. Security Prioritization

- **Automated Security PRs**: Dependabot Security Alerts immediately generate targeted security patch PRs regardless of the weekly schedule.
- **Triaging SLAs**:
  - **Critical / High CVEs**: Must be reviewed, tested via CI, and merged within 48 hours.
  - **Moderate / Low CVEs**: Batched with weekly automated dependency updates.

---

## 4. Exception & Pinning Policy

1. **Protocol Compatibility**:
   - Soroban smart contract dependencies (`soroban-sdk`) must correspond to the Stellar protocol version supported on target testnet and mainnet networks.
   - Upgrading `soroban-sdk` across major protocol boundaries requires formal cross-contract integration testing and migration reviews before merging.
2. **Manual Exceptions**:
   - If a dependency update breaks backwards compatibility or introduces regression bugs, the package may be temporarily ignored using Dependabot `ignore` rules with an explanatory comment referencing the tracked issue.
