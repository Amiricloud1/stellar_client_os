# Deployment Credential Custody and Network Separation — issue #108

This document describes how deployment credentials are stored, validated,
rotated, and separated between testnet and mainnet.

## Preflight validation

`scripts/deploy.sh` runs `validate_credentials` immediately after loading
`.env` and aborts (exit 1) before any network activity when credentials are
missing or mismatched:

- `NETWORK` must be `testnet` or `mainnet`.
- `STELLAR_SECRET_KEY` must be present and shaped like a Stellar secret key
  (starts with `S`, 56 characters).
- The network-appropriate passphrase variable must be present:
  `TESTNET_NETWORK_PASSPHRASE` for testnet, `MAINNET_NETWORK_PASSPHRASE` for
  mainnet.
- The passphrase value must equal the expected network passphrase
  (`Test SDF Network ; September 2015` for testnet,
  `Public Global Stellar Network ; September 2015` for mainnet).
- Testnet and mainnet passphrases must not be identical.

The same rules are encoded in `packages/sdk/src/deployment-credentials.ts`
(`validateCredentials`) with deterministic unit coverage
(`packages/sdk/src/__tests__/deployment-credentials.test.ts`).

## Least privilege

- Use a dedicated deployer account that holds only the XLM needed for
  deployment fees; do not reuse treasury, admin, or user keys.
- Restrict who can approve or run deployments; mainnet deployments require an
  admin actor (see `docs/privileged-action-audit.md`).
- CI deploy jobs receive only the secrets they need (e.g.
  `TESTNET_SECRET_KEY` for testnet) and never mainnet keys on untrusted refs.

## CI secret use

- Store deployer secrets as environment-scoped GitHub secrets (never in
  `.env`, logs, or the repo).
- Export them only into the deploy step's `env:` block.
- Redact secrets in logs; `sanitizeMetadata` guarantees audit records never
  store them.

## Rotation

- Rotate deployer keys on a regular cadence and immediately after any
  suspected exposure or personnel change.
- After rotation, verify with the preflight: a stale or truncated key fails
  `INVALID_SECRET_KEY` before deployment.
- Record each rotation as `rotate.credential` in the audit log.

## Testnet / mainnet separation

- Testnet and mainnet use distinct RPC endpoints, passphrases, and
  credentials. `NETWORK_PARAPHRASE` in `deploy.sh` is selected from the
  network-appropriate variable; it is no longer hardcoded to testnet.
- `validate_credentials` rejects a testnet passphrase against mainnet (and
  vice versa) and rejects identical passphrases across networks.
- `deployments/testnet.json` and `deployments/mainnet.json` keep
  per-network contract addresses; never copy a testnet address file over a
  mainnet one.
