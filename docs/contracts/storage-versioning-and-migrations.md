# Persistent Storage Versioning and Migrations Guide

## 1. Overview & Standard

All Fundable Stellar smart contracts adhere to an explicit storage layout schema versioning standard. Each contract maintains a schema version marker stored in instance storage under `DataKey::SchemaVersion`.

### Schema Versioning Guarantees
- **Explicit Version Markers**: Contracts define a compile-time `SCHEMA_VERSION: u32` constant and store the active version in instance storage.
- **Idempotent Migrations**: Calling `migrate_schema()` multiple times is idempotent and safe; if the contract is already at or above the target version, it completes without mutating state or re-emitting events.
- **Strict Authority**: Schema migrations can only be initiated by the designated contract `Admin`.
- **Auditable Events**: Every migration emits a `SchemaMigrated` event capturing the previous schema version, new schema version, and timestamp.

---

## 2. Upgrade Proxy Authorization & Recovery

The `UpgradeProxyContract` controls contract upgrades across the platform through a 48-hour timelock.

### Security Hardening
1. **Implementation Hash Validation**:
   - Rejects zero / empty implementation hashes (`[0u8; 32]`).
   - Rejects proposals matching the currently deployed implementation hash (`Error::InvalidImplementationHash`).
2. **Upgrade State Machine**:
   - Prevents duplicate or concurrent upgrade proposals via `Error::UpgradeAlreadyPending`. An in-flight proposal must either be executed or explicitly cancelled before proposing another.
3. **Emergency Rollback**:
   - Upon execution of any upgrade, the prior implementation hash is archived in `DataKey::PreviousImplementationHash`.
   - In case of critical defect or exploit in a new WASM build, the admin can call `emergency_rollback()`, which immediately restores the previous hash and clears pending proposals.
4. **Emergency Recovery**:
   - If both current and prior hashes are non-functional, `emergency_recovery(fallback_hash)` enables the admin to immediately point the proxy to a vetted fallback implementation.

---

## 3. Deterministic Campaign Diversity Scoring

The `CampaignDiversityContract` evaluates ecological quality by converting verified tree plantings into a biodiversity score between 0 and 10,000 basis points.

### Scoring Specification
- **Inputs**:
  - `species_count`: Number of distinct verified species ($S \le 64$).
  - `verified_tree_count`: Total verified trees ($N \le 1,000,000,000$).
  - `same_species_pairs`: Sum of ordered pairs per species $\sum n_i(n_i - 1)$.
- **Normalization**:
  - Coverage: Linear ramp up to `MAX_DIVERSITY_SPECIES = 12` native species.
  - Evenness: Normalized Simpson's diversity index $(1 - D) / (1 - 1/S)$, scaled to 10,000 basis points.
- **Rounding Policy**:
  - Pure integer arithmetic with integer floor division at each intermediate operation.
  - Floating-point calculations are strictly forbidden to ensure identical results across all Soroban host runtimes.
- **Auditability**:
  - `calculate_score(...)` provides an off-chain view of the deterministic score formula.
  - `rescore_campaign(...)` allows authorized administrators to trigger state verification and emit `DiversityScoreUpdatedEvent`.

---

## 4. SDK Transaction Waiting & Cancellation

The SDK utility `waitForTransaction` provides full lifecycle modeling for Soroban RPC transactions:
- **Statuses**: `SUCCESS`, `FAILED`, `PENDING`, `NOT_FOUND`, `EXPIRED`, `TIMEOUT`, and `ABORTED`.
- **Cancellation**: Supports `AbortSignal` for immediate or in-flight cancellation.
- **Typed Results**: Supports `throwOnFailure: false` to return typed `TransactionWaitResult` objects with status, ledger, hash, and error details instead of throwing.
