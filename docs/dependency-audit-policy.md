# Dependency & License Audit Policy Gates (Issue #98)

This document defines the automated vulnerability and license compliance policy gates enforced across `pnpm` (TypeScript/JavaScript workspaces) and `Cargo` (Soroban Rust smart contracts).

---

## 1. Policy Configuration & Architecture

- **Canonical Policy File:** `security/dependency-audit-policy.json`
- **Cargo Deny Configuration:** `contracts/deny.toml`
- **Policy Evaluation Engine:** `apps/web/src/lib/security/dependency-audit-policy.ts`
- **CLI Gate Runner:** `scripts/dependency-audit-gate.mjs` (`pnpm security:audit`)
- **CI Workflow:** `.github/workflows/dependency-audit.yml` (runs on pull requests, pushes to `main`, and daily scheduled scans at `06:00 UTC`).

---

## 2. Vulnerability Severity Thresholds & Remediation SLAs

The policy gate fails whenever any unsuppressed vulnerability in `pnpm` or `Cargo` has a severity of **`high`** or **`critical`** (`failOnSeverity: "high"`).

| Severity | Fails Policy Gate? | Remediation SLA |
| :--- | :--- | :--- |
| `critical` | **Yes** (Blocks PR & Scheduled CI) | **1 day (24h)** |
| `high` | **Yes** (Blocks PR & Scheduled CI) | **7 days** |
| `moderate` | No (Reported in audit summary) | **30 days** |
| `low` | No (Reported in audit summary) | **90 days** |

---

## 3. Remediation Ownership Mapping

Every finding is automatically assigned to an accountable engineering owner based on package/workspace path or ecosystem:

| Scope | Assigned Owner |
| :--- | :--- |
| `@fundable/web` | `@Fundable-Protocol/web-team` |
| `@fundable/sdk` | `@Fundable-Protocol/sdk-team` |
| `@fundable/mobile` | `@Fundable-Protocol/mobile-team` |
| `contracts/*` (Soroban Rust) | `@Fundable-Protocol/contracts-team` |
| Fallback / Unmapped | `@Fundable-Protocol/security` |

---

## 4. License Policy Gate

- **Allowed Permissive SPDX Identifiers:** `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `0BSD`, `CC0-1.0`, `Unlicense`, `Zlib`, `BlueOak-1.0.0`, `CC-BY-3.0`, `CC-BY-4.0`, `Unicode-3.0`, `Unicode-DFS-2016`, `Python-2.0`, `MPL-2.0`.
- **Denied Copyleft / Restrictive Identifiers:** `GPL-2.0*`, `GPL-3.0*`, `AGPL-3.0*`, `SSPL-1.0`, `BSL-1.1`, `UNLICENSED`.
- **Unknown Licenses:** Rejected when `failOnUnknownLicense: true`.

---

## 5. Expiring Suppressions Lifecycle

When an upstream fix is not immediately available and a vulnerability is verified as non-exploitable in our usage context, a temporary suppression can be added to `suppressions` in `security/dependency-audit-policy.json`:

```json
{
  "id": "GHSA-xxxx-xxxx-xxxx",
  "package": "example-pkg",
  "ecosystem": "pnpm",
  "reason": "Build-time only dependency; upstream patch tracked in #123",
  "owner": "@Fundable-Protocol/sdk-team",
  "createdAt": "2026-10-17T00:00:00.000Z",
  "expiresAt": "2026-11-17T00:00:00.000Z",
  "trackingIssue": "#123"
}
```

### Strict Suppression Validation Rules
1. **Mandatory Metadata:** Every suppression must include a non-empty `id`, `package`, `ecosystem`, `reason`, and `@owner` team handle.
2. **Maximum Horizon (`maxSuppressionDays: 90`):** Suppressions with an expiration window exceeding 90 days fail the policy gate (`SUPPRESSION_TTL_EXCEEDED`).
3. **Automatic Expiration Enforcement:** As soon as `now >= expiresAt`, the policy gate fails with `EXPIRED_SUPPRESSION` during daily scheduled or PR runs until the dependency is upgraded or re-evaluated.

---

## 6. Running Locally & Compatibility Implications

```bash
# Run the CLI policy gate against the workspace policy and manifests
pnpm security:audit

# Run the automated policy gate unit test suite
pnpm --filter @fundable/web test src/lib/security/dependency-audit-policy.test.ts
```

- **Compatibility & Migration:** Existing workflows (`frontend.yml`, `contracts.yml`, `sdk.yml`) remain unchanged; `.github/workflows/dependency-audit.yml` adds dedicated PR and daily cron enforcement without breaking offline builds.
