# Contributing to stellar_client_os

Thank you for contributing. This guide is intentionally short: repository
policy lives in [`STYLE_GUIDE.md`](./STYLE_GUIDE.md) (branches, commits, PR
requirements) and the environment inventory in
[`docs/environment-variables.md`](./docs/environment-variables.md).
Start there; what follows is only the contributor workflow checklist.

## Workflow

1. Pick an issue, then create a branch from an up-to-date `main`:
   `feature/<issue>-<short-description>`, `bugfix/<issue>-<short-description>`,
   or `chore/<issue>-<short-description>`.
2. Make the smallest change that fixes the issue. Match existing code style,
   naming, architecture, and testing patterns; don't bundle unrelated work.
3. Validate before pushing (Linux commands — see `TESTING_GUIDE.md`):
   - `pnpm validate:affected` checks changed packages and workspace dependents.
   - `pnpm lint` checks web, mobile, and SDK; `pnpm lint:contracts` runs Clippy.
   - `pnpm format:check` checks JS/TS and Rust formatting.
   - `pnpm --filter @fundable/sdk test && pnpm --filter @fundable/sdk build`
   - `pnpm test:contracts` / `pnpm build:contracts` when touching `contracts/`
   - offline-layer changes: `pnpm --filter @fundable/mobile test`
4. Open one focused PR against upstream `main` using the PR template. Related
   issues that share a change may be linked in the same PR.
   (`.github/PULL_REQUEST_TEMPLATE.md`). Fill every section: affected packages,
   risk/security notes, validation evidence, migrations, and docs impact.
   The `Quality Gates` workflow always reports stable `Web`, `Mobile`, `SDK`, and
   `Rust` checks on fork and same-repository pull requests. Require these four
   checks in branch protection.
5. Keep review fixes on the same branch as focused follow-up commits.

## Contract wasm artifacts

`pnpm build:contracts` derives the deployable contract set from the Cargo
workspace members under `contracts/` rather than a hardcoded list. The build
fails when a deployable workspace member is omitted from the artifact set or
when its compiled `.wasm` artifact is missing, so adding a new contract crate
to the workspace is enough to bring it into the deployment build.

- When you add a contract crate, register it as a workspace member and make
  sure it produces a wasm artifact; the build will flag it otherwise.
- Non-deployable members (e.g. shared libraries) must be excluded explicitly
  from the deployable set so the build does not expect a wasm for them.
- Run `pnpm build:contracts` locally before opening a PR that touches
  `contracts/`; CI runs the same check.

## What reviewers check

- Scope: only the linked issue(s); no unrelated refactors or dependency churn.
- Tests: success, failure, and boundary cases; deterministic, no live funds.
- Docs: behavior changes update the owning package's docs
  (`apps/mobile/OFFLINE.md`, `docs/environment-variables.md`, etc.).
- Secrets: no credentials, keys, or `.env` contents in commits or descriptions.

## Advanced PRs (contracts / migrations / security-sensitive)

- State compatibility explicitly: additive vs breaking, and the migration path.
- Contract changes need `cargo test` evidence plus SDK/web impact notes.
- Security-sensitive changes (auth, signing, rate limits, uploads) name the
  threat considered and why the change is safe.
