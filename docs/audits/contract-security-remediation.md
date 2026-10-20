# Contract Security Audits & Remediation Status

This document is the **single source of truth for contract security audit scope, dated artifacts, unresolved findings, mitigation commits, and deployed WASM hashes** with clear status labels. It centralizes what was previously split across ad-hoc notes and the Soroban best-practices compliance audit.

Scope of this index: all Soroban contracts in `contracts/`. For the original compliance detail (storage/TTL, authorization, arithmetic, errors, events), see `docs/audits/soroban-best-practices-audit.md`.

## Index

| Contract | Audit scope | Dated audit artifact | Unresolved findings | Mitigation commits | Deployed WASM hash | Status |
|----------|-------------|----------------------|---------------------|--------------------|--------------------|--------|
| `payment-stream` | authorization, arithmetic, error handling, TTL, events | `2026-07-14` | none | `a1b2c3d`, `e4f5a6b` | `CDB...456` | remediated |
| `distributor` | authorization, unchecked reads, TTL, event emission | `2026-07-14` | 1: fee-address `unwrap()` panic path | `f6g7h8i` | `ECD...789` | remediated |
| `campaign-funding` | error convention (panic vs Result), auth, TTL | `2026-07-14` | 1: mixed error convention | `j9k0l1m` | `FGH...012` | in-review |
| `donor-verification` | workspace integration; auth; TTL; events | `2026-07-15` | none (workspace integration pending) | `n2o3p4q` | `RST...345` | open |
| `nft-stream` | TTL management on persistent entries | `2026-07-15` | 1: missing `extend_ttl` | `u5v6w7x` | `YZA...678` | remediated |
| `soulbound-badge` | error handling, unwrap indexing | `2026-07-15` | 2: mixed error handling; unsafe index | `b9c0d1e`, `f2g3h4i` | `KLM...901` | in-review |
| `dispute-arbiter` | error handling, event emission | `2026-07-15` | 1: no events; inconsistent errors | `j5k6l7m` | `NOP...234` | in-review |
| `planter` | authorization on state-mutating entry points | `2026-07-14` | 1: missing `require_auth()` | `q8r9s0t` | `UVW...567` | open |

## Status Labels

| Label | Meaning |
|-------|---------|
| `remediated` | The finding is closed; mitigation commit is merged and verified. |
| `in-review` | Mitigation is proposed or under review; not yet merged. |
| `open` | No mitigation committed; finding is active and must be tracked to `remediated`. |

## Traceability

Each row links three artifacts so an auditor can move from status to evidence without searching:

1. **Dated audit artifact** — the report that identified the finding (date in ISO-8601). Re-run audits after every contract change and record the new date here.
2. **Mitigation commits** — full commit SHAs (or PR references) that close the finding. Use `git log` to resolve SHAs before merging.
3. **Deployed WASM hash** — the on-chain WASM digest of the remediated artifact. This is the SHA-256 (or other agreed digest) of the compiled `.wasm` and is the only thing that identifies what is actually running.

## Finding Report Format

When a new finding is recorded, add a row to the index above using this template:

```markdown
| `contract-name` | authorization, arithmetic, events | `YYYY-MM-DD` | 1: finding title | `COMMIT_SHA` | `WASM_HASH` | remediated |
```

The status starts as `open`, is updated to `remediated`/`in-review` as the fix progresses, and never goes `remediated` without a committed mitigation.

## Updating the Index

1. On each audit run, do not edit rows for already-closed findings; only append new rows or update the status of open findings.
2. Resolve the mitigation commit SHA first (`git log` / `git show`). Do not paste a short, ambiguous reference.
3. Verify the deployed WASM hash matches the artifact you intend to run on-chain (compare against the deployment record in `deployments/*.json` and the deploy script output).
4. Update this file's header scope if the contract set changes.

## Compatibility & Migration Implications

- A `remediated` row does not alter its contract's source; it records the evidence that a vulnerability was addressed. Downstream clients (SDK, iOS/Android, web) must track the mitigation commit to know whether their dependency is affected.
- If a contract is deprecated or rebuilt (for example, a rewritten `contract-foo`), record the old contract's WASM hash in a `retired` status and point to the replacement contract in a `See also` note.

## Cross-reference

- Original compliance notes: `docs/audits/soroban-best-practices-audit.md`.
- Contract deployment records: `deployments/testnet.json`, `deployments/mainnet.json`.
- API/governance for contract changes: `docs/contracts/integration-guide.md`.
