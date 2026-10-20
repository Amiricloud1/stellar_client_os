# Contributing to stellar_client_os

Thank you for contributing. This guide is intentionally short: repository
policy lives in [`STYLE_GUIDE.md`](./STYLE_GUIDE.md) (branches, commits, PR
requirements) and the environment inventory in
[`docs/environment-variables.md`](./docs/environment-variables.md).
Start there; what follows is only the contributor workflow checklist.

## Supported toolchain

This repository supports exactly one toolchain. The canonical pins live in
machine-readable files at the repo root and are consumed by both local
development and CI:

| Tool | Pin file | Notes |
| --- | --- | --- |
| Node.js | `.nvmrc` | LTS line; `nvm use` / `fnm use` picks it up |
| pnpm | `package.json` (`packageManager`) | Enable via `corepack enable` |
| Rust | `rust-toolchain.toml` | Channel + components pinned |
| Stellar CLI | `rust-toolchain.toml` / `scripts/check-toolchain.sh` | Version checked by the script |

Run the version check before you start and before you push:

```bash
pnpm check:toolchain
```

The check compares your installed Node, pnpm, Rust, and Stellar CLI versions
against the pins and exits non-zero with an actionable message naming the
tool, the expected version, and the detected version when they diverge. CI runs
the same check, so drift is caught automatically. If you intentionally bump a
pin, update the pin file and the check together in the same PR and note the
compatibility/migration impact in the PR description.

## Workflow

1. Pick an issue, then create a branch from an up-to-date `main`:
   `feature/<issue>-<short-description>`, `bugfix/<issue>-<short-description>`,
   or `chore/<issue>-<short-description>`.
2. Make the smallest change that fixes the issue. Match existing code style,
   naming, architecture, and testing patterns; don't bundle unrelated work.
3. Validate before pushing (Linux commands — see `TESTING_GUIDE.md`):
   - `pnpm check:toolchain`
   - `pnpm --filter @fundable/sdk test && pnpm --filter @fundable/sdk build`
   - `pnpm --filter @fundable/web lint` (same-repo; fork PRs skip repo-wide lint)
   - `pnpm test:contracts` / `pnpm build:contracts` when touching `contracts/`
   - offline-layer changes: `pnpm --filter @fundable/mobile test`
4. Open one PR per issue against upstream `main` using the PR template
   (`.github/PULL_REQUEST_TEMPLATE.md`). Fill every section: affected packages,
   risk/security notes, validation evidence, migrations, and docs impact.
5. Keep review fixes on the same branch as focused follow-up commits.

## What reviewers check

- Scope: only the linked issue(s); no unrelated refactors or dependency churn.
- Toolchain: pins are unchanged unless the PR is explicitly about them, and
  `pnpm check:toolchain` passes.
- Tests: success, failure, and boundary cases; deterministic, no live funds.
- Docs: behavior changes update the owning package's docs
  (`apps/mobile/OFFLINE.md`, `docs/environment-variables.md`, etc.).
- Secrets: no credentials, keys, or `.env` contents in commits or descriptions.

## Advanced PRs (contracts / migrations / security-sensitive)

- State compatibility explicitly: additive vs breaking, and the migration path.
- Contract changes need `cargo test` evidence plus SDK/web impact notes.
- Security-sensitive changes (auth, signing, rate limits, uploads) name the
  threat considered and why the change is safe.
