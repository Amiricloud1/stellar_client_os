# Privileged Roles and Contract Authorization Matrix

This document provides a comprehensive inventory of all privileged methods and role expectations across all contracts in the Fundable Protocol.

## Role Hierarchy & Expectations

| Role | Responsibility | Standard Error on Unauthorized Access |
|---|---|---|
| **Protocol Admin** | Manages global protocol parameters (fee rates, collectors, upgrade timelocks, arbiter lists) | `Error::Unauthorized` (#3) / `Error::NotAdmin` (#1) |
| **Campaign Creator** | Manages campaign lifecycle, assigns planters, claims raised funds post-success | `Error::Unauthorized` (#3) / `CampaignNotFound` |
| **Authorized Verifier** | Inspects tree planting proof, signs off on escrow releases, logs audit checkpoints | `Error::UnauthorizedVerifier` (#42) |
| **Registered Planter** | Submits planting batches and GPS/photo evidence within verification SLAs | `Error::Unauthorized` (#3) |
| **Dispute Arbiter** | Resolves disputed streams, escrow holds, and contested verification reports | `Error::Unauthorized` (#3) |
| **Non-Profit Partner** | Mints 501(c)(3) tax deduction certificates for registered campaigns | `Error::Unauthorized` (#3) |

---

## Contract Privileged Method Inventory

### 1. `campaign-funding`
- `initialize(admin, fee_collector, fee_rate)`: Uninitialized only; requires `admin.require_auth()`.
- `set_fee_rate(new_rate)`: Admin only.
- `set_fee_collector(new_collector)`: Admin only.
- `set_stream_contract(contract_address)`: Admin only.
- `add_matching_funds(campaign_id, amount, cap)`: Admin only.
- `claim_funds(campaign_id)`: Campaign creator only. Rejects non-creators with `Error::Unauthorized`.
- `assign_planter(campaign_id, planter)`: Campaign creator only. One-time assignment within 90-day window.
- `approve_tree_verification(campaign_id, count)`: Assigned campaign verifier only. Rejects non-verifiers with `Error::UnauthorizedVerifier`.

### 2. `campaign-verification-audit`
- `log_approved(campaign_id, verifier, notes)`: Verifier only (`verifier.require_auth()`).
- `log_rejected(campaign_id, verifier, notes)`: Verifier only.
- `log_verifier_comments(campaign_id, verifier, comments)`: Verifier only.
- `verify_trees_batch(campaign_id, verifier, count)`: Verifier only.
- `log_submitted_for_review(campaign_id, submitter, notes)`: Submitter only (`submitter.require_auth()`).

### 3. `donor-verification`
- `initialize(admin, initial_root)`: Uninitialized only; requires `admin.require_auth()`.
- `update_root(admin, new_root)`: Stored admin only. Rejects any other caller with `Error::NotAdmin`.
- `revoke_nullifier(admin, nullifier, evidence_hash)`: Stored admin only.

### 4. `soulbound-badge`
- `initialize(admin, accepted_token)`: Uninitialized only; requires `admin.require_auth()`.
- `revoke_badge(admin, badge_id)`: Stored admin only. Rejects strangers with `Error::Unauthorized`.
- `transfer(from, to, badge_id)`: **Strictly non-transferable**. Always rejected with `Error::NonTransferable`.

### 5. `verifier-penalty`
- `initialize(admin)`: Uninitialized only.
- `report_offense(admin, verifier, offense_id, evidence_hash, amount)`: Admin only.
- `resolve_appeal(admin, report_id, uphold)`: Admin only.
- `appeal(verifier, report_id)`: Penalised verifier only. Rejects third parties with `Error::NotReportedVerifier`.

### 6. `payment-stream`
- `initialize(admin, fee_collector, fee_rate)`: Uninitialized only.
- `set_fee_collector(collector)`: Admin only.
- `set_fee_rate(rate)`: Admin only.
- `pause_stream(stream_id)`: Stream sender or designated delegate only.
- `cancel_stream(stream_id)`: Stream sender only.
- `withdraw(stream_id, amount)`: Stream recipient or authorized delegate only.

### 7. `distributor`
- `initialize(admin)`: Admin only.
- `set_admin(new_admin)`: Current admin only.

### 8. `nft-stream`
- `initialize(admin)`: Admin only.
- `mint_ownership_record(admin, owner, stream_id)`: Admin only.

### 9. `planter`
- `initialize(admin, reward_token, reward_amount)`: Admin only.
- `set_reward_amount(amount)`: Admin only.
- `complete_job(planter, job_id)`: Registered planter only.

### 10. `dispute-arbiter`
- `initialize(admin)`: Admin only.
- `resolve_dispute(arbiter, dispute_id, ruling)`: Designated arbiter only.

### 11. `timelock`
- `initialize(admin)`: Admin only.
- `propose_action(admin, action_id, delay)`: Admin only.
- `execute_action(admin, action_id)`: Admin only after delay has elapsed.
- `cancel_action(admin, action_id)`: Admin only.

### 12. `upgrade-proxy`
- `initialize(admin)`: Admin only.
- `propose_upgrade(admin, new_wasm_hash)`: Admin only.
- `approve_upgrade(admin, new_wasm_hash)`: Admin only after timelock.

### 13. `sponsor-crowdfunding`
- `initialize(admin, token)`: Admin only.
- `set_admin(new_admin)`: Admin only.

### 14. `sponsor-insurance`
- `initialize(admin)`: Admin only.
- `set_admin(new_admin)`: Admin only.

### 15. `tax-deduction-certificate`
- `initialize(admin, registry)`: Admin only.
- `issue_certificate(partner, campaign_id, sponsor, year, token)`: Registered non-profit partner only.

---

## Negative Authorization Test Guarantees

Every contract test suite includes explicit negative authorization tests asserting:
1. Re-initialization attempts are rejected with `AlreadyInitialized`.
2. Calls before initialization fail with `NotInitialized`.
3. Actions with caller address checks reject mismatched callers with `Unauthorized` or `NotAdmin`.
4. Role-specific operations (e.g. verifier approvals, creator claims, planter updates) fail when called by unauthorized accounts.
