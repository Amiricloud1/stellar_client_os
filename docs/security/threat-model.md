# Threat Model: Financial and Identity Trust Boundaries

Issue: [Amiricloud1/stellar_client_os#96](https://github.com/Amiricloud1/stellar_client_os/issues/96)

This document is the maintained threat model for Fundable Protocol. It inventories
the assets we must protect, the trust boundaries they cross, the attacker
capabilities we defend against, the mitigations in place, and the residual risks
we accept. It is validated in CI by
`scripts/security/validate-threat-model.mjs` (see the "High-risk controls"
tracking table below — every row must carry a status of `implemented`,
`planned`, or `accepted`).

**Scope:** web frontend (`apps/web`), backend API (`apps/web/api`), TypeScript
SDK (`packages/sdk`), Soroban smart contracts (`contracts/`), campaign media
uploads (IPFS), the mobile offline client (`apps/mobile`), and the CI/deploy
pipeline (`.github/workflows`, `deployments/`).

**Out of scope:** third-party infrastructure we do not operate (Stellar
network consensus, IPFS pinning services, GitHub's own platform security) —
these are treated as trusted-but-verify dependencies and appear under residual
risk.

## Assets

| Asset | Where it lives | Impact if compromised |
| ----- | -------------- | --------------------- |
| User wallet secret keys | User devices / wallet providers (never this repo — see [SECURITY_AUDIT_378.md](../SECURITY_AUDIT_378.md)) | Full theft of user funds |
| Campaign escrow funds | Soroban `campaign-funding` / `payment-stream` contract storage | Direct loss of sponsored funds |
| Distributor payout logic | Soroban `distributor` contract | Manipulated token distributions |
| Deployer / admin credentials | CI secrets, operator keypairs | Malicious contract upgrades, fund drainage |
| Sponsor identity data | API database (addresses, emails in digests) | Doxxing, phishing, regulatory exposure |
| Campaign media uploads | IPFS via backend upload service | Misleading verification evidence |
| Contract deployment records | `deployments/*.json` | Targeting of known admin addresses |
| SDK consumers' trust | `packages/sdk` published package | Supply-chain compromise of integrators |

## Trust boundaries

| # | Boundary | Crossing | Enforcement |
| - | -------- | -------- | ----------- |
| B1 | Browser ↔ Frontend/API | User input, session tokens | Input validation, wallet-signature auth, rate limiting ([rate-limits.md](../rate-limits.md)) |
| B2 | API ↔ Soroban contracts | Transactions signed server-side or by wallet | Non-custodial signing (wallet provider only), amount/asset checks |
| B3 | Contracts ↔ Stellar network | Transaction submission | Soroban auth macros, contract-owned escrow |
| B4 | API ↔ IPFS uploads | Campaign media from sponsors | Size/type validation, content-addressed CIDs, no arbitrary URLs |
| B5 | Mobile client ↔ API | Queued offline mutations (wishlist), telemetry | Deterministic queue merge; telemetry is privacy-safe and opt-in (`apps/mobile/OFFLINE.md`) |
| B6 | CI/CD ↔ Deployments | Build secrets, deploy keypairs | Environment-scoped secrets, branch-protected merges, secret scanning ([secret-rotation.md](secret-rotation.md)) |
| B7 | SDK consumers ↔ published package | npm publish | Changesets release flow, CI-gated publish |

## Attacker capabilities

| ID | Attacker | Capability assumed |
| -- | -------- | ------------------ |
| A1 | External network attacker | Observe/modify unencrypted traffic; host phishing sites |
| A2 | Malicious sponsor (authenticated user) | Submit arbitrary campaign metadata and upload content within API limits |
| A3 | Malicious contract caller | Call any public contract function with crafted arguments |
| A4 | Compromised CI credential | Push to non-protected branches, read repository secrets, tamper with release artifacts |
| A5 | Compromised operator key | Sign administrative transactions (deploy, upgrade, pause) |
| A6 | Malicious SDK consumer | Pass arbitrary inputs through the SDK to the network |

## Mitigations

| Threat | Attacker | Boundary | Mitigation | Status |
| ------ | -------- | -------- | ---------- | ------ |
| Client-side key exfiltration via deployer | A1 | B2 | Non-custodial signing; no secret-key parameters anywhere client-side ([SECURITY_AUDIT_378.md](../SECURITY_AUDIT_378.md)) | implemented |
| Reentrancy / balance manipulation in escrow | A3 | B3 | Soroban auth macros; escrow owned by contract; unit tests per contract | implemented |
| Unbounded payout arithmetic | A3 | B3 | Checked decimal math in distributor/campaign contracts | implemented |
| Spam / resource exhaustion of API | A1, A2 | B1 | Rate limiting per [rate-limits.md](../rate-limits.md) | implemented |
| Malicious upload content (XSS via media) | A2 | B4 | Content-addressed IPFS CIDs; served as downloads, not inline HTML | implemented |
| Secrets committed to the repository | A4 | B6 | Pre-merge secret scanning (`.gitleaks.toml` + `scripts/security/scan-secrets.mjs`, see [secret-rotation.md](secret-rotation.md)) | implemented |
| Telemetry leaking wallet/draft data | A1 | B5 | Allowlist-based sanitizer; opt-in sink; field-exclusion tests (`apps/mobile/src/offline/__tests__/telemetry.test.ts`) | implemented |
| Stale queue replaying destructive edits | A1 | B5 | Deterministic latest-wins merge; conflict retries bounded by reconnects | implemented |
| Fraudulent campaign verification evidence | A2 | B4 | Verification audit trail (`campaign-verification-audit` contract) | implemented |
| Supply-chain compromise of published SDK | A4 | B7 | CI-gated changesets publish; lockfile-pinned workspace | planned |
| Admin key compromise (A5) | A5 | B2, B6 | Hardware-held operator keys; multi-sig / threshold control of admin actions | planned |
| Denial of service of IPFS pinning | A1 | B4 | Multiple pinning providers / re-pin runbook | planned |

## Residual risks

- **Stellar network level:** consensus liveness and ledger forks are outside our
  control; contract design assumes eventual consistency of ledgers.
- **Wallet provider compromise:** a user's chosen wallet can always sign away
  their funds; we cannot mitigate a compromised signer on the user's device.
- **IPFS permanence:** content addressed by CID may persist on public IPFS even
  after we stop pinning it (privacy takedowns are best-effort).
- **Phishing:** no mitigation in-repo can stop a user from signing a malicious
  transaction on a look-alike site; domain monitoring is operational, not code.
- **Operator single-signer phase:** until threshold control ships (see below),
  a fully compromised operator key can deploy contracts.

## High-risk controls

Every row must be one of `implemented`, `planned`, `accepted` — enforced by
`scripts/security/validate-threat-model.mjs` in CI.

| Control | Covers | Owner surface | Status |
| ------- | ------ | ------------- | ------ |
| Non-custodial signing (no client-side secret keys) | A1/B2 fund theft | apps/web, packages/sdk | implemented |
| Pre-merge secret scanning + rotation runbook | A4/B6 credential leaks | .github/workflows, scripts/security | implemented |
| Privacy-safe offline sync telemetry | A1/B5 identity leak | apps/mobile | implemented |
| Rate limiting on campaign/API endpoints | A1, A2/B1 | apps/web | implemented |
| Threshold admin keys for contract operations | A5/B2, B6 | contracts, deployments | planned |
| SDK release provenance (signed/attested publishes) | A4/B7 | packages/sdk, .github/workflows | planned |
| Contract fuzzing for escrow arithmetic | A3/B3 | contracts | planned |
| Remove hardcoded Stellar testnet seed fallback in `campaign-verification/stream` route (move fully to `ANCHOR_SECRET_KEY`; replace test fixture with a generated keypair) | A4/B6 credential leaks | apps/web | planned |

## Maintenance

- Update this document when a new asset, boundary, contract, or upload surface
  is introduced; treat "unknown" gaps as defects.
- CI validates structure and control tracking on every change to this file or
  the validator (`security.yml`); keep the table statuses accurate when closing
  out planned controls.
- Historical ad-hoc audits live in [audits/](../audits) and
  [SECURITY_AUDIT_378.md](../../SECURITY_AUDIT_378.md); durable findings belong
  here.

