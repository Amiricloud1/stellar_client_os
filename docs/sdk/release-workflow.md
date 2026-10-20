# SDK Changeset and Release Workflow

This document details the end-to-end release lifecycle for `@fundable/sdk`.

## Overview

The SDK uses [Changesets](https://github.com/changesets/changesets) for semver versioning, changelog management, and npm publication.

---

## 1. Adding a Changeset

When submitting PRs that affect `@fundable/sdk`, generate a changeset markdown entry:

```bash
pnpm changeset
```

Select `@fundable/sdk`, choose the semver bump type (`patch`, `minor`, `major`), and provide a clear, human-readable summary of the changes.

Commit the generated file in `.changeset/<random-slug>.md`.

---

## 2. Dry-Run Verification

Before releasing or pushing to `main`, validate package metadata and changeset configuration locally:

```bash
pnpm changeset:dry-run
```

This performs automated pre-flight checks:
- Verifies `@fundable/sdk` package name, license, and semver compliance.
- Ensures `.changeset/config.json` is configured with `access: "public"`.
- Counts and validates pending changeset entries.

---

## 3. Automated CI Release Flow

When commits land on `main`, `.github/workflows/release.yml` triggers automatically:

1. Runs full test suites (`pnpm test:sdk`).
2. Runs `changeset version` if changesets exist, opening a Release Pull Request.
3. Once the Release PR is merged, runs `pnpm changeset:publish`:
   - Builds `@fundable/sdk` via `pnpm --filter @fundable/sdk build`.
   - Publishes to npm using the configured `NPM_TOKEN`.
   - Tags the release on GitHub.

---

## 4. Prerelease & Snapshot Releases

For testing unreleased features on testnet:

```bash
pnpm changeset pre enter next
pnpm changeset version
pnpm changeset publish --tag next
```

Exit prerelease mode once verified:

```bash
pnpm changeset pre exit
```
