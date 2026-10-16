# Secret Scanning & Credential Rotation

Issue: [Amiricloud1/stellar_client_os#97](https://github.com/Amiricloud1/stellar_client_os/issues/97)

This document defines how Fundable Protocol blocks secrets before merge and
how to rotate credentials when they are compromised — locally, in CI, or in a
deployment environment.

## Pre-merge secret scanning

Two independent gates run in CI (`.github/workflows/security.yml`) on every
push and pull request:

| Gate | Tool | Coverage |
| ---- | ---- | -------- |
| Industry ruleset | [gitleaks](https://github.com/gitleaks/gitleaks) with `.gitleaks.toml` | Default rules + Stellar seeds, GitHub/AWS/Slack/npm tokens, PEM blocks |
| Repo-native scanner | `scripts/security/scan-secrets.mjs` (dependency-free Node) | The same representative pattern classes, with deterministic `node --test` coverage in `scripts/security/*.test.mjs` |

Run both locally before pushing:

```bash
node scripts/security/scan-secrets.mjs            # scans git-tracked files
gitleaks detect --source . -c .gitleaks.toml --redact   # if gitleaks is installed
node --test 'scripts/security/*.test.mjs'         # scanner/validator unit tests
```

**If a finding is a deliberate fixture** (e.g. a generated-looking test
constant), do not weaken the rules. Allowlist the specific path in
`DEFAULT_ALLOWLIST` (`scripts/security/scan-secrets.mjs`) and in the
`[allowlist]` section of `.gitleaks.toml`, with the reason written next to it —
mirroring the existing entries (AWS docs example key, scanner fixtures, and the
pre-existing testnet seeds tracked for removal in
[threat-model.md](threat-model.md)).

> Note: scanning prevents *new* secrets from merging. It does not clean
> history — for that, rotate first (below), then purge with
> `git filter-repo` as a follow-up if the credential is sensitive enough.

## Rotation runbooks

A compromised credential must be **revoked first, investigated second**. When
in doubt, rotate.

### 1. Local developer credentials

| Credential | Rotate by |
| ---------- | --------- |
| Wallet secret keys (testnet or mainnet) | Never reuse. Generate a fresh keypair, move any funds/roles to the new address, and update the environment (`ANCHOR_SECRET_KEY`, deployer configs). Stellar keys cannot be "reset" — replacement is the only rotation. |
| `.env` values (`scripts/deploy.sh`, local Horizon RPC accounts) | Delete the `.env`, pull a fresh copy of `.env.example`, re-issue each value, and purge the shell history if the secret was typed interactively. |
| Personal access tokens (GitHub, npm) | Revoke in the provider's settings page, then create a replacement and update every machine and CI secret that used it. |

### 2. CI credentials (GitHub Actions)

Trigger: a secret used by `.github/workflows/*` may have leaked into logs, a
fork PR, or an artifact.

1. **Revoke immediately** at the provider: GitHub → Settings → Developer
   settings → tokens; npm → Access Tokens; cloud IAM consoles.
2. **Update the store**: repository *Settings → Secrets and variables →
   Actions* (prefer environment-scoped secrets so rotation is per-environment).
3. **Re-run the last workflow** with the new secret to confirm the pipeline
   heals, and review workflow run logs for the exposure window.
4. **File the incident** as an issue referencing
   [threat-model.md](threat-model.md) boundary **B6**.

### 3. Deployment / production credentials

Trigger: a server, container registry, IPFS pinning service, or
Horizon/Soroban RPC account credential may have been exposed.

1. Revoke/rotate at the provider (hosting provider SSH keys, registry tokens,
   pinning-service API keys, Horizon RPC account seeds).
2. Update the deployment environment (never commit replacements to
   `deployments/*.json` — those files record **public** contract ids only).
3. Sweep for use of the old credential: `git log -S'<identifier>' --all` plus
   the provider's own audit log.
4. If a **Stellar operator/admin keypair** was exposed: treat the funds and
   admin rights it controls as compromised. Deploy a new keypair, transfer
   admin roles through the contracts' own authority flows, and only then retire
   the old address. Threshold/multi-sig control is tracked as a planned control
   in [threat-model.md](threat-model.md).

## Incident checklist

- [ ] Revoke the credential at the issuing provider.
- [ ] Issue a replacement and update every consumer (local, CI, deployment).
- [ ] Re-run affected workflows/tests to confirm the pipeline is healthy.
- [ ] Determine the exposure window from provider audit logs.
- [ ] Record the incident and link the relevant trust boundary in
      [threat-model.md](threat-model.md).
- [ ] If the secret was committed: rotate **first**, then decide separately
      whether history purge is warranted.
