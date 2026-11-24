# SDK Changeset and Release Workflow

This document details the end-to-end release lifecycle for `@fundable/sdk` and Soroban WASM release artifacts.

## Overview

The SDK uses [Changesets](https://github.com/changesets/changesets) for semver versioning, changelog management, and attested npm publication (`NPM_CONFIG_PROVENANCE=true`), paired with Ed25519 release artifact signing and provenance verification (`@fundable/sdk` provenance APIs and `scripts/release-provenance.mjs`).

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
   - Publishes to npm with `id-token: write` and `NPM_CONFIG_PROVENANCE=true` for signed npm provenance attestations.
   - Tags the release on GitHub.
4. Builds Soroban `.wasm` artifacts in `publish-wasm`, writes `dist/wasm/SHA256SUMS` and `dist/wasm/provenance.json`, signs `provenance.json` into `dist/wasm/provenance.sig.json` with Ed25519, and verifies both signature and artifact digests before uploading or attaching assets to the GitHub release.

---

## 4. Artifact Signing and Provenance Verification

### CI configuration

Configure these repository secrets and variables for signed WASM releases:

- `RELEASE_SIGNING_PRIVATE_KEY` (secret): Ed25519 PKCS#8 PEM private key (raw or base64-encoded).
- `RELEASE_SIGNING_PUBLIC_KEY` (secret): Matching Ed25519 SPKI PEM public key (raw or base64-encoded).
- `REQUIRE_SIGNED_RELEASES` (variable): Set to `"true"` in production to fail closed if signing secrets are missing.

### Local operator verification

Operators and integrators can verify downloaded release bundles offline using the dependency-free CLI:

```bash
node scripts/release-provenance.mjs verify \
  --statement dist/wasm/provenance.json \
  --signature dist/wasm/provenance.sig.json \
  --dir dist/wasm \
  --public-key-file release-signing.pub.pem \
  --expected-repo Amiricloud1/stellar_client_os \
  --expected-commit <40-char-sha> \
  --allowed-ref refs/heads/main
```

Programmatic consumers can verify statements and artifact buffers directly via `@fundable/sdk`:

```ts
import { assertValidReleaseProvenance } from "@fundable/sdk";

const verified = assertValidReleaseProvenance(statement, signatureEnvelope, {
  trustedSigners: [{ keyId, publicKeyPem }],
  expectedRepository: "Amiricloud1/stellar_client_os",
  allowedRefs: ["refs/heads/main", "refs/tags/v*"],
}, artifactBuffers);
```

### Failure states and key rotation recovery

Verification fails closed with explicit error codes and recovery hints:

- `DIGEST_MISMATCH` / `SIGNATURE_INVALID`: Do not deploy; artifact bytes or metadata were altered or signed by a mismatched key.
- `UNTRUSTED_SIGNER` / `UNAUTHORIZED_REPOSITORY` / `UNAUTHORIZED_REF` / `COMMIT_MISMATCH`: Reject artifacts outside policy scope.
- `SIGNER_REVOKED` / `SIGNER_EXPIRED`: Mark compromised or aged keys as `revoked: true` in the trusted signer keyring, rotate `RELEASE_SIGNING_PRIVATE_KEY` / `RELEASE_SIGNING_PUBLIC_KEY`, and re-run the release workflow to publish freshly signed provenance.

---

## 5. Prerelease & Snapshot Releases

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
