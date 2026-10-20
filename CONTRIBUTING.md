# Contributing to stellar_client_os

Thank you for contributing. This guide is intentionally short: repository
policy lives in [`STYLE_GUIDE.md`](./STYLE_GUIDE.md) (branches, commits, PR
requirements) and the environment inventory in
[`docs/environment-variables.md`](./docs/environment-variables.md).
Start there; what follows is only the contributor workflow checklist.

## Toolchain

The Rust compiler and wasm target are pinned in
[`rust-toolchain.toml`](./rust-toolchain.toml) at the repository root. CI and
local contract builds both consume that file, so the versions always match.

- Install [rustup](https://rustup.rs) if you don't already have it. With
  rustup present, the pinned channel and `wasm32-unknown-unknown` target are
  installed automatically the first time you run a `cargo` command inside the
  repo — no manual `rustup target add` needed.
- If you use a non-rustup Rust install, you must install the pinned channel and
  wasm target yourself; otherwise `pnpm build:contracts` / `pnpm test:contracts`
  will fail or produce artifacts that differ from CI.
- Bumping the toolchain is a compatibility change: update `rust-toolchain.toml`
  in the same PR and note the migration impact (e.g. minimum rustup version) in
  the PR description.

## Reproducible contract builds

Contract wasm must be byte-for-byte reproducible so that a release artifact can
be rebuilt and verified by anyone. `pnpm verify:reproducible` builds the
contracts twice in clean, pinned environments and compares the normalized wasm
hashes; CI runs the same check on every PR that touches `contracts/`.

How it works:

- Each build runs in a fresh `target/` directory with the pinned toolchain from
  `rust-toolchain.toml`, so no stale artifacts leak between runs.
- Before hashing, the wasm is **normalized** to strip legitimate
  nondeterministic metadata that does not affect behavior:
  - absolute build paths embedded in panic/debug strings (e.g. `/home/runner/...`
    vs `/Users/you/...`) are replaced with a stable placeholder;
  - the `producers`/`name` custom sections that record toolchain paths are
    dropped;
  - any trailing build-timestamp custom section is removed.
- The normalized bytes are hashed (SHA-256) and the two hashes are compared. A
  match means the build is reproducible; a mismatch means something
  nondeterministic leaked into the artifact.

Interpreting results:

- **Hashes match** — reproducible. Record the hash in the PR validation
  evidence.
- **Hashes differ** — a real nondeterminism bug. Common causes: an unpinned
  dependency, a build script reading the clock or environment, or a new custom
  section that isn't normalized. Fix the source; do not loosen the comparison.
- **Missing/empty artifact** — the build failed or produced no wasm; the check
  fails loudly rather than hashing an empty file.

The normalization and comparison logic is covered by automated tests (success,
metadata-only differences, hash mismatch, and empty/missing artifacts) that run
without network access or live funds. Update those tests alongside any change to
the normalization rules.

## CI dependency caches

CI caches pnpm and Cargo dependencies to keep warm runs fast. Cache keys are
derived from the lockfile hash, toolchain version, build target, and runner OS,
so a cache is only reused when all of those match:

- **pnpm** — keyed by `pnpm-lock.yaml` hash + Node version + runner OS. The
  pnpm store is cached, not `node_modules`.
- **Cargo** — keyed by `Cargo.lock` hash + `rust-toolchain.toml` channel +
  build target + runner OS. The Cargo registry and `target/` are cached.

Implications for contributors:

- A cache miss (new lockfile, bumped toolchain, different OS/target) is always
  safe: CI falls back to a cold install/build and still succeeds. Never rely on
  a warm cache for correctness.
- Changing `pnpm-lock.yaml`, `Cargo.lock`, or `rust-toolchain.toml` invalidates
  the relevant cache; expect the first run after such a change to be slower.
- Cache key derivation is covered by automated tests (success, failure, and
  boundary cases such as a missing lockfile or differing OS/target/toolchain).
  Update those tests alongside any change to the caching logic.

## Workflow

1. Pick an issue, then create a branch from an up-to-date `main`:
   `feature/<issue>-<short-description>`, `bugfix/<issue>-<short-description>`,
   or `chore/<issue>-<short-description>`.
2. Make the smallest change that fixes the issue. Match existing code style,
   naming, architecture, and testing patterns; don't bundle unrelated work.
3. Validate before pushing (Linux commands — see `TESTING_GUIDE.md`):
   - `pnpm --filter @fundable/sdk test && pnpm --filter @fundable/sdk build`
   - `pnpm --filter @fundable/web lint` (same-repo; fork PRs skip repo-wide lint)
   - `pnpm test:contracts` / `pnpm build:contracts` when touching `contracts/`
   - `pnpm verify:reproducible` when touching `contracts/` (reproducible build check)
   - offline-layer changes: `pnpm --filter @fundable/mobile test`
4. Open one PR per issue against upstream `main` using the PR template
   (`.github/PULL_REQUEST_TEMPLATE.md`). Fill every section: affected packages,
   risk/security notes, validation evidence, migrations, and docs impact.
5. Keep review fixes on the same branch as focused follow-up commits.

## What reviewers check

- Scope: only the linked issue(s); no unrelated refactors or dependency churn.
- Tests: success, failure, and boundary cases; deterministic, no live funds.
- Docs: behavior changes update the owning package's docs
  (`apps/mobile/OFFLINE.md`, `docs/environment-variables.md`, etc.).
- Secrets: no credentials, keys, or `.env` contents in commits or descriptions.

## Advanced PRs (contracts / migrations / security-sensitive)

- State compatibility explicitly: additive vs breaking, and the migration path.
- Contract changes need `cargo test` evidence plus SDK/web impact notes.
- Contract changes must pass the reproducible-build check; include the
  normalized wasm hash in the PR validation evidence.
- Security-sensitive changes (auth, signing, rate limits, uploads) name the
  threat considered and why the change is safe.
