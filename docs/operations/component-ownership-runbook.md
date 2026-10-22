# Component Ownership & Operations Runbook Index

This document is the single source of truth for **who owns which component** of the Fundable Protocol, where that owner monitors it, which runbooks govern incident response, and what the component depends on. It is the index for all operations runbooks and is designed to be **regenerated and kept current on every ownership change**.

The component set tracked here is stable and authority-driven:

| # | Component | Category | Owner | Monitoring dashboard | Primary runbook | Runtime dependencies |
|---|-----------|----------|-------|----------------------|-----------------|----------------------|
| 1 | Web frontend (`apps/web`) | Web | Frontend owners (platform web) | Sentry error dashboard; Vercel/Node logs | `docs/frontend/` → incident runbook | payment-stream, distributor, campaign-funding contracts; planter; DNS/edge |
| 2 | REST API (`apps/api` / `apps/web` backend routes) | API | Backend/API owners | APIPublic/Sentry; request latency dashboard | `docs/api/error-handling.md` → API incident runbook | campaign-funding, donor-verification, planter contracts; Redis session/cache |
| 3 | SDK (`packages/sdk`) | SDK | SDK maintainers | CI test matrix; maintainers Slack channel | `packages/sdk/DEVELOPMENT_GUIDE.md` → SDK maintenance runbook | `@stellar/stellar-sdk`, emitted Soroban events, local node/testnet/mainnet RPC |
| 4 | Soroban contracts (`contracts/`) | Contracts | Contracts team | Soroban Explorer explorer + event indexer | `docs/contracts/integration-guide.md` → contract upgrade/incident runbook | Stellar testnet/mainnet; deployed WASM hashes (see `docs/audits/contract-security-remediation.md`) |
| 5 | Mobile app (`apps/mobile`) | Mobile | Mobile owners | Sentry crash dashboard; FCM/APNS push console | `apps/mobile/OFFLINE.md` → mobile incident runbook | payment-stream, campaign-funding, planter contracts; push provider |
| 6 | Deployment & infrastructure (`deployments/`, CI) | Deployment | DevOps/infra owners | GitHub Actions runs; deployment status dashboard | `deployments/` → deploy runbook; GitHub Actions logs | Rust toolchain + Stellar CLI; Stellar RPC endpoints; deployment keyring |

## Dashboard ↔ Owner Mapping

| Dashboard | Data source | Owner |
|-----------|-------------|-------|
| Sentry (error rates, latency, release) | frontend + API + mobile | Frontend/API owners |
| Soroban Explorer + custom event indexer | on-chain contract state | Contracts team |
| GitHub Actions / deploy status | CI pipeline + `deployments/*.json` | DevOps |
| push console (FCM/APNS) | mobile push delivery | Mobile owners |

## Runtime Dependencies

Every component in the table above declares its runtime dependencies. When you change an owner or a dependency, update the following locations:

1. `docs/operations/component-ownership-runbook.md` — this file (the canonical index).
2. `README.md` → `## Project Structure` — optional high-level map for contributors.
3. Each owner's own runbook under `docs/` or the component directory.

## Updating Ownership

Ownership is **not** self-mutating. To change an owner (or to add/remove a component):

1. Propose the change in a PR whose description references the component and the new owner's communication channel.
2. Update this runbook's ownership table and dependency columns.
3. Update the referenced dashboards and runbooks to point at the new owner/owner channel.
4. Validate that all links in this runbook resolve and that the owner mapping covers every component above.
5. CI runs the docs-validation suite in `.github/workflows/docs.yml`, which asserts the ownership table has one row per required component and that no owner is empty.

## Escalation Path

| Severity | Owner | Next hop |
|----------|-------|----------|
| P0 (outage) | Component owner (see table) | On-call infra / DevOps |
| P1 (degraded) | Component owner | Contracts team if contracts-driven |
| P2 (security) | Contracts team → SDK maintainers if SDK | Security incident channel |

## Compatibility & Migration Implications

- Changing a component owner does not change behavior, but stale runbook links can misroute incident response. Validate links after every ownership change.
- If a component is deprecated or replaced (for example, a contract is superseded), mark its row `retired` in the ownership table and keep a pointer to the replacement in a `See also` note.
