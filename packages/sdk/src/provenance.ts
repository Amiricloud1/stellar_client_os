import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";

/**
 * Release artifact signing and provenance verification — issue #283.
 *
 * Signs canonicalized release provenance statements with Ed25519 and verifies
 * signer trust, key revocation/expiry, repository/ref/commit authorization,
 * statement integrity, and SHA-256 artifact digests before publication or
 * consumption.
 *
 * Compatible with the schemaVersion 1 `provenance.json` emitted by
 * `.github/workflows/release.yml`.
 */

export const PROVENANCE_SCHEMA_VERSION = 1 as const;
export const PROVENANCE_SIGNATURE_DOMAIN = "fundable-release-provenance-v1";

export interface ArtifactDigest {
  /** Single-segment artifact filename (e.g. `payment_stream.wasm`). */
  name: string;
  /** Lowercase 64-character SHA-256 hex digest of the artifact bytes. */
  sha256: string;
  /** Optional artifact size in bytes. */
  sizeBytes?: number;
}

export interface ReleaseProvenanceStatement {
  schemaVersion: 1;
  /** Full 40-character hexadecimal Git commit SHA. */
  commit: string;
  /** Git ref that built the release (e.g. `refs/heads/main`, `refs/tags/v0.2.0`). */
  ref: string;
  /** Repository slug (`owner/repo`). */
  repository: string;
  /** Build target (e.g. `wasm32-unknown-unknown`, `npm`). */
  target: string;
  /** Build profile (e.g. `release`). */
  profile: string;
  checksumAlgorithm: "sha256";
  artifacts: ArtifactDigest[];
  rustc?: string;
  cargo?: string;
  packageName?: string;
  packageVersion?: string;
  workflow?: string;
  runId?: string;
  builtAt?: string;
}

export interface ArtifactSignatureEnvelope {
  schemaVersion: 1;
  algorithm: "ed25519";
  /** Identifier for the signing key (e.g. `sha256:<16-hex>` fingerprint). */
  keyId: string;
  /** Human- or automation-readable signer identity. */
  signer: string;
  /** ISO-8601 UTC timestamp when the statement was signed. */
  signedAt: string;
  /** SHA-256 hex digest of the canonicalized provenance statement. */
  statementSha256: string;
  /** Base64-encoded Ed25519 signature over the domain-separated payload. */
  signature: string;
}

export interface TrustedSigner {
  keyId: string;
  publicKeyPem: string;
  allowedRepositories?: string[];
  allowedRefs?: string[];
  revoked?: boolean;
  /** Optional ISO-8601 UTC expiry timestamp for key rotation enforcement. */
  expiresAt?: string;
}

export interface ProvenanceVerificationPolicy {
  trustedSigners: TrustedSigner[];
  expectedRepository?: string;
  expectedCommit?: string;
  allowedRefs?: string[];
  /**
   * When true (default), every supplied artifact must appear in the signed
   * statement and every attested artifact must be present when artifacts are
   * provided for verification.
   */
  requireAllArtifactsMatched?: boolean;
  /** Injectable clock for deterministic expiry checks in tests. */
  now?: Date;
}

export type ProvenanceErrorCode =
  | "INVALID_STATEMENT"
  | "INVALID_SIGNATURE_ENVELOPE"
  | "SIGNING_KEY_INVALID"
  | "UNTRUSTED_SIGNER"
  | "SIGNER_REVOKED"
  | "SIGNER_EXPIRED"
  | "UNAUTHORIZED_REPOSITORY"
  | "UNAUTHORIZED_REF"
  | "COMMIT_MISMATCH"
  | "DIGEST_MISMATCH"
  | "SIGNATURE_INVALID"
  | "MISSING_ARTIFACT"
  | "UNEXPECTED_ARTIFACT";

export class ProvenanceError extends Error {
  readonly code: ProvenanceErrorCode;
  readonly recoveryHint: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ProvenanceErrorCode,
    message: string,
    recoveryHint: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ProvenanceError";
    this.code = code;
    this.recoveryHint = recoveryHint;
    this.details = details;
  }
}

export function isProvenanceError(error: unknown): error is ProvenanceError {
  return error instanceof ProvenanceError;
}

export interface SignReleaseProvenanceOptions {
  privateKeyPem: string;
  signer: string;
  keyId?: string;
  signedAt?: string;
}

export type ProvenanceVerificationResult =
  | {
      ok: true;
      keyId: string;
      signer: string;
      statementSha256: string;
      verifiedArtifacts: string[];
    }
  | {
      ok: false;
      code: ProvenanceErrorCode;
      message: string;
      recoveryHint: string;
      details?: Record<string, unknown>;
    };

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function canonicalizeValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeValue(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalizeValue(obj[key])}`
  );
  return `{${entries.join(",")}}`;
}

/**
 * Normalize an artifact name by stripping at most one leading `./` (produced
 * by `sha256sum ./*.wasm`) and asserting it is a safe single-segment basename.
 */
export function normalizeArtifactName(rawName: string): string {
  if (typeof rawName !== "string") {
    throw new ProvenanceError(
      "INVALID_STATEMENT",
      "Artifact name must be a string",
      "Regenerate provenance.json with valid single-segment artifact names"
    );
  }
  const trimmed = rawName.trim();
  const stripped = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  if (
    stripped.length === 0 ||
    stripped.includes("..") ||
    stripped.includes("/") ||
    stripped.includes("\\") ||
    !SAFE_ARTIFACT_NAME_PATTERN.test(stripped)
  ) {
    throw new ProvenanceError(
      "INVALID_STATEMENT",
      `Unsafe or invalid artifact filename: "${rawName}"`,
      "Use single-segment basenames without path traversal in provenance.json",
      { artifactName: rawName }
    );
  }
  return stripped;
}

/** Compute lowercase SHA-256 hex digest for raw artifact bytes. */
export function computeArtifactSha256(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Derive a deterministic key identifier from an Ed25519 SPKI public key PEM. */
export function computePublicKeyId(publicKeyPem: string): string {
  try {
    const keyObj = createPublicKey(publicKeyPem);
    if (keyObj.asymmetricKeyType !== "ed25519") {
      throw new Error("Expected an Ed25519 public key");
    }
    const der = keyObj.export({ type: "spki", format: "der" });
    const fingerprint = createHash("sha256")
      .update(der)
      .digest("hex")
      .slice(0, 16);
    return `sha256:${fingerprint}`;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid public key";
    throw new ProvenanceError(
      "SIGNING_KEY_INVALID",
      `Invalid Ed25519 public key: ${message}`,
      "Configure a valid Ed25519 SPKI PEM public key in trustedSigners"
    );
  }
}

/**
 * Validate a release provenance statement against the schemaVersion 1
 * contract, rejecting malformed digests, invalid commit SHAs, or unsafe paths.
 */
export function validateProvenanceStatement(
  statement: ReleaseProvenanceStatement
): ReleaseProvenanceStatement {
  if (!statement || typeof statement !== "object") {
    throw new ProvenanceError(
      "INVALID_STATEMENT",
      "Provenance statement must be an object",
      "Provide a valid schemaVersion 1 provenance.json payload"
    );
  }
  if (statement.schemaVersion !== PROVENANCE_SCHEMA_VERSION) {
    throw new ProvenanceError(
      "INVALID_STATEMENT",
      `Unsupported provenance schemaVersion: ${String(statement.schemaVersion)}`,
      "Upgrade verifier or regenerate provenance.json with schemaVersion 1"
    );
  }
  if (
    typeof statement.commit !== "string" ||
    !GIT_COMMIT_PATTERN.test(statement.commit)
  ) {
    throw new ProvenanceError(
      "INVALID_STATEMENT",
      `Invalid Git commit SHA: "${String(statement.commit)}"`,
      "Regenerate provenance.json with the full 40-char commit SHA"
    );
  }
  if (typeof statement.ref !== "string" || statement.ref.trim().length === 0) {
    throw new ProvenanceError(
      "INVALID_STATEMENT",
      "Provenance statement is missing a non-empty ref",
      "Populate ref (for example refs/heads/main or refs/tags/v0.2.0)"
    );
  }
  if (
    typeof statement.repository !== "string" ||
    !REPOSITORY_PATTERN.test(statement.repository)
  ) {
    throw new ProvenanceError(
      "INVALID_STATEMENT",
      `Invalid repository slug: "${String(statement.repository)}"`,
      "Set repository to the canonical owner/repo slug"
    );
  }
  if (
    typeof statement.target !== "string" ||
    statement.target.trim().length === 0 ||
    typeof statement.profile !== "string" ||
    statement.profile.trim().length === 0
  ) {
    throw new ProvenanceError(
      "INVALID_STATEMENT",
      "Provenance statement requires non-empty target and profile fields",
      "Include target and profile in provenance.json"
    );
  }
  if (statement.checksumAlgorithm !== "sha256") {
    throw new ProvenanceError(
      "INVALID_STATEMENT",
      `Unsupported checksumAlgorithm: "${String(statement.checksumAlgorithm)}"`,
      "Use sha256 checksums for all release artifacts"
    );
  }
  if (!Array.isArray(statement.artifacts) || statement.artifacts.length === 0) {
    throw new ProvenanceError(
      "INVALID_STATEMENT",
      "Provenance statement must list at least one artifact",
      "Include all built release artifacts in provenance.json before signing"
    );
  }

  const seen = new Set<string>();
  const normalizedArtifacts: ArtifactDigest[] = [];
  for (const artifact of statement.artifacts) {
    const name = normalizeArtifactName(artifact.name);
    if (seen.has(name)) {
      throw new ProvenanceError(
        "INVALID_STATEMENT",
        `Duplicate artifact entry in provenance statement: "${name}"`,
        "Deduplicate artifact digests in SHA256SUMS and provenance.json",
        { artifactName: name }
      );
    }
    seen.add(name);

    const sha256 =
      typeof artifact.sha256 === "string"
        ? artifact.sha256.trim().toLowerCase()
        : "";
    if (!SHA256_HEX_PATTERN.test(sha256)) {
      throw new ProvenanceError(
        "INVALID_STATEMENT",
        `Invalid SHA-256 digest for artifact "${name}"`,
        "Recompute 64-character lowercase SHA-256 digests",
        { artifactName: name }
      );
    }
    if (
      artifact.sizeBytes !== undefined &&
      (!Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes < 0)
    ) {
      throw new ProvenanceError(
        "INVALID_STATEMENT",
        `Invalid sizeBytes for artifact "${name}"`,
        "Provide a non-negative integer byte count",
        { artifactName: name }
      );
    }
    normalizedArtifacts.push({
      name,
      sha256,
      ...(artifact.sizeBytes !== undefined
        ? { sizeBytes: artifact.sizeBytes }
        : {}),
    });
  }

  normalizedArtifacts.sort((a, b) => a.name.localeCompare(b.name));

  return {
    ...statement,
    commit: statement.commit.toLowerCase(),
    artifacts: normalizedArtifacts,
  };
}

/** Produce a deterministic canonical JSON string for signing and hashing. */
export function canonicalizeProvenanceStatement(
  statement: ReleaseProvenanceStatement
): string {
  const normalized = validateProvenanceStatement(statement);
  return canonicalizeValue(normalized);
}

/**
 * Parse a `SHA256SUMS` file into validated `ArtifactDigest[]` entries.
 */
export function parseSha256Sums(content: string): ArtifactDigest[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (lines.length === 0) {
    throw new ProvenanceError(
      "INVALID_STATEMENT",
      "SHA256SUMS file contains no checksum entries",
      "Regenerate SHA256SUMS from built release artifacts"
    );
  }

  const seen = new Set<string>();
  const digests: ArtifactDigest[] = [];

  for (const line of lines) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!match) {
      throw new ProvenanceError(
        "INVALID_STATEMENT",
        `Malformed SHA256SUMS line: "${line}"`,
        "Format SHA256SUMS as '<64-hex-sha256>  <filename>'"
      );
    }
    const sha256 = match[1].toLowerCase();
    const name = normalizeArtifactName(match[2]);
    if (seen.has(name)) {
      throw new ProvenanceError(
        "INVALID_STATEMENT",
        `Duplicate artifact "${name}" in SHA256SUMS`,
        "Remove duplicate entries from SHA256SUMS"
      );
    }
    seen.add(name);
    digests.push({ name, sha256 });
  }

  return digests.sort((a, b) => a.name.localeCompare(b.name));
}

function buildSigningPayload(canonicalStatement: string): Buffer {
  return Buffer.from(
    `${PROVENANCE_SIGNATURE_DOMAIN}\n${canonicalStatement}`,
    "utf8"
  );
}

function constantTimeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a.toLowerCase(), "utf8");
  const bufB = Buffer.from(b.toLowerCase(), "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Sign a validated release provenance statement with an Ed25519 private key.
 * Produces an `ArtifactSignatureEnvelope` suitable for publication alongside
 * `provenance.json` and `SHA256SUMS`.
 */
export function signReleaseProvenance(
  statement: ReleaseProvenanceStatement,
  options: SignReleaseProvenanceOptions
): ArtifactSignatureEnvelope {
  const canonicalStatement = canonicalizeProvenanceStatement(statement);
  const signer = options.signer?.trim();
  if (!signer) {
    throw new ProvenanceError(
      "INVALID_SIGNATURE_ENVELOPE",
      "Signer identity is required when signing provenance",
      "Provide a non-empty signer identity (for example workflow or bot id)"
    );
  }

  let privateKey;
  let derivedPublicKeyPem: string;
  try {
    privateKey = createPrivateKey(options.privateKeyPem);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Signing key must be an Ed25519 private key");
    }
    const pubKey = createPublicKey(privateKey);
    derivedPublicKeyPem = pubKey
      .export({ type: "spki", format: "pem" })
      .toString();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load private key";
    throw new ProvenanceError(
      "SIGNING_KEY_INVALID",
      `Invalid release signing key: ${message}`,
      "Provide a valid Ed25519 PKCS#8 PEM private key via CI secret storage"
    );
  }

  const keyId =
    options.keyId?.trim() || computePublicKeyId(derivedPublicKeyPem);
  const signedAt = options.signedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(signedAt))) {
    throw new ProvenanceError(
      "INVALID_SIGNATURE_ENVELOPE",
      `Invalid signedAt timestamp: "${signedAt}"`,
      "Provide a valid ISO-8601 UTC timestamp"
    );
  }

  const statementSha256 = createHash("sha256")
    .update(canonicalStatement, "utf8")
    .digest("hex");
  const payload = buildSigningPayload(canonicalStatement);
  const rawSignature = sign(null, payload, privateKey);

  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    algorithm: "ed25519",
    keyId,
    signer,
    signedAt,
    statementSha256,
    signature: rawSignature.toString("base64"),
  };
}

function fail(
  code: ProvenanceErrorCode,
  message: string,
  recoveryHint: string,
  details?: Record<string, unknown>
): ProvenanceVerificationResult {
  return { ok: false, code, message, recoveryHint, details };
}

function matchesRefPattern(ref: string, allowedRefs: string[]): boolean {
  return allowedRefs.some((pattern) => {
    if (pattern.endsWith("*")) {
      return ref.startsWith(pattern.slice(0, -1));
    }
    return ref === pattern;
  });
}

/**
 * Authoritatively verify a signed release provenance statement against a trust
 * policy and optional artifact bytes or precomputed SHA-256 digests.
 *
 * Returns a structured `ProvenanceVerificationResult` with explicit failure
 * codes and operator recovery hints (never silently passes on misconfiguration).
 */
export function verifyReleaseProvenance(
  statement: ReleaseProvenanceStatement,
  envelope: ArtifactSignatureEnvelope,
  policy: ProvenanceVerificationPolicy,
  artifacts?: Record<string, Uint8Array | Buffer | string>
): ProvenanceVerificationResult {
  let normalized: ReleaseProvenanceStatement;
  let canonicalStatement: string;
  try {
    normalized = validateProvenanceStatement(statement);
    canonicalStatement = canonicalizeValue(normalized);
  } catch (error) {
    if (isProvenanceError(error)) {
      return fail(error.code, error.message, error.recoveryHint, error.details);
    }
    return fail(
      "INVALID_STATEMENT",
      "Invalid provenance statement",
      "Verify provenance.json format"
    );
  }

  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.schemaVersion !== PROVENANCE_SCHEMA_VERSION ||
    envelope.algorithm !== "ed25519" ||
    typeof envelope.keyId !== "string" ||
    !envelope.keyId.trim() ||
    typeof envelope.signer !== "string" ||
    !envelope.signer.trim() ||
    typeof envelope.signature !== "string" ||
    !envelope.signature.trim() ||
    typeof envelope.statementSha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(envelope.statementSha256.toLowerCase()) ||
    typeof envelope.signedAt !== "string" ||
    Number.isNaN(Date.parse(envelope.signedAt))
  ) {
    return fail(
      "INVALID_SIGNATURE_ENVELOPE",
      "Signature envelope is malformed or uses an unsupported algorithm",
      "Re-sign provenance.json using Ed25519 and schemaVersion 1"
    );
  }

  const trustedSigner = (policy.trustedSigners ?? []).find(
    (candidate) => candidate.keyId === envelope.keyId
  );
  if (!trustedSigner) {
    return fail(
      "UNTRUSTED_SIGNER",
      `Signing key "${envelope.keyId}" is not in the trusted signer keyring`,
      "Verify release signer identity or update the trusted signer keyring",
      { keyId: envelope.keyId }
    );
  }

  if (trustedSigner.revoked) {
    return fail(
      "SIGNER_REVOKED",
      `Signing key "${trustedSigner.keyId}" has been revoked`,
      "Rotate to an active release signing key and re-sign the release artifacts",
      { keyId: trustedSigner.keyId }
    );
  }

  const nowMs = (policy.now ?? new Date()).getTime();
  const signedAtMs = Date.parse(envelope.signedAt);
  if (trustedSigner.expiresAt) {
    const expiresAtMs = Date.parse(trustedSigner.expiresAt);
    if (
      Number.isNaN(expiresAtMs) ||
      signedAtMs > expiresAtMs ||
      nowMs > expiresAtMs
    ) {
      return fail(
        "SIGNER_EXPIRED",
        `Signing key "${trustedSigner.keyId}" expired at ${trustedSigner.expiresAt}`,
        "Rotate the release signing key and re-sign artifacts with an active key",
        { keyId: trustedSigner.keyId, expiresAt: trustedSigner.expiresAt }
      );
    }
  }

  if (
    policy.expectedRepository &&
    normalized.repository !== policy.expectedRepository
  ) {
    return fail(
      "UNAUTHORIZED_REPOSITORY",
      `Provenance repository "${normalized.repository}" does not match expected "${policy.expectedRepository}"`,
      "Reject artifacts built from unexpected repositories",
      {
        expected: policy.expectedRepository,
        actual: normalized.repository,
      }
    );
  }

  if (
    trustedSigner.allowedRepositories &&
    trustedSigner.allowedRepositories.length > 0 &&
    !trustedSigner.allowedRepositories.includes(normalized.repository)
  ) {
    return fail(
      "UNAUTHORIZED_REPOSITORY",
      `Signer "${trustedSigner.keyId}" is not authorized for repository "${normalized.repository}"`,
      "Use a key scoped to this repository or update signer repository policy",
      { keyId: trustedSigner.keyId, repository: normalized.repository }
    );
  }

  if (
    policy.allowedRefs &&
    policy.allowedRefs.length > 0 &&
    !matchesRefPattern(normalized.ref, policy.allowedRefs)
  ) {
    return fail(
      "UNAUTHORIZED_REF",
      `Provenance ref "${normalized.ref}" is not in the allowed release refs`,
      "Build and sign releases only from protected release branches or tags",
      { ref: normalized.ref, allowedRefs: policy.allowedRefs }
    );
  }

  if (
    trustedSigner.allowedRefs &&
    trustedSigner.allowedRefs.length > 0 &&
    !matchesRefPattern(normalized.ref, trustedSigner.allowedRefs)
  ) {
    return fail(
      "UNAUTHORIZED_REF",
      `Signer "${trustedSigner.keyId}" is not authorized for ref "${normalized.ref}"`,
      "Sign release artifacts from an authorized ref for this key",
      { keyId: trustedSigner.keyId, ref: normalized.ref }
    );
  }

  if (
    policy.expectedCommit &&
    !constantTimeHexEqual(normalized.commit, policy.expectedCommit)
  ) {
    return fail(
      "COMMIT_MISMATCH",
      `Provenance commit "${normalized.commit}" does not match expected "${policy.expectedCommit}"`,
      "Verify you downloaded artifacts corresponding to the expected commit",
      { expected: policy.expectedCommit, actual: normalized.commit }
    );
  }

  const computedStatementSha256 = createHash("sha256")
    .update(canonicalStatement, "utf8")
    .digest("hex");
  if (
    !constantTimeHexEqual(computedStatementSha256, envelope.statementSha256)
  ) {
    return fail(
      "DIGEST_MISMATCH",
      "Provenance statement digest does not match signed envelope digest",
      "Do not deploy tampered artifacts; re-download or rebuild and re-sign",
      {
        expected: envelope.statementSha256,
        actual: computedStatementSha256,
      }
    );
  }

  let publicKey;
  try {
    publicKey = createPublicKey(trustedSigner.publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Trusted signer key must be Ed25519");
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid public key";
    return fail(
      "SIGNING_KEY_INVALID",
      `Invalid trusted signer public key: ${message}`,
      "Replace the malformed public key in the trusted signer configuration",
      { keyId: trustedSigner.keyId }
    );
  }

  const payload = buildSigningPayload(canonicalStatement);
  const signatureBytes = Buffer.from(envelope.signature, "base64");
  const signatureValid =
    signatureBytes.length === 64 &&
    verify(null, payload, publicKey, signatureBytes);

  if (!signatureValid) {
    return fail(
      "SIGNATURE_INVALID",
      "Ed25519 signature verification failed for release provenance statement",
      "Do not deploy; verify the signing key matches and artifacts were not altered",
      { keyId: trustedSigner.keyId }
    );
  }

  const verifiedArtifacts: string[] = [];
  if (artifacts !== undefined) {
    const requireAll = policy.requireAllArtifactsMatched ?? true;
    const normalizedInputMap = new Map<string, Uint8Array | Buffer | string>();
    for (const [rawName, value] of Object.entries(artifacts)) {
      let cleanName: string;
      try {
        cleanName = normalizeArtifactName(rawName);
      } catch (error) {
        if (isProvenanceError(error)) {
          return fail(
            error.code,
            error.message,
            error.recoveryHint,
            error.details
          );
        }
        return fail(
          "INVALID_STATEMENT",
          `Invalid artifact name: ${rawName}`,
          "Use valid single-segment artifact names"
        );
      }
      normalizedInputMap.set(cleanName, value);
    }

    const attestedNames = new Set(normalized.artifacts.map((a) => a.name));
    if (requireAll) {
      for (const suppliedName of normalizedInputMap.keys()) {
        if (!attestedNames.has(suppliedName)) {
          return fail(
            "UNEXPECTED_ARTIFACT",
            `Unattested artifact "${suppliedName}" is not listed in signed provenance`,
            "Remove unattested files or rebuild and re-sign the full release set",
            { artifactName: suppliedName }
          );
        }
      }
    }

    for (const attested of normalized.artifacts) {
      const supplied = normalizedInputMap.get(attested.name);
      if (supplied === undefined) {
        return fail(
          "MISSING_ARTIFACT",
          `Attested artifact "${attested.name}" is missing from release bundle`,
          "Re-download the complete release bundle before verifying",
          { artifactName: attested.name }
        );
      }

      const actualDigest =
        typeof supplied === "string"
          ? supplied.trim().toLowerCase()
          : computeArtifactSha256(supplied);

      if (
        !SHA256_HEX_PATTERN.test(actualDigest) ||
        !constantTimeHexEqual(actualDigest, attested.sha256)
      ) {
        return fail(
          "DIGEST_MISMATCH",
          `SHA-256 digest mismatch for artifact "${attested.name}"`,
          "Abort deployment; artifact contents do not match signed provenance",
          {
            artifactName: attested.name,
            expected: attested.sha256,
            actual: actualDigest,
          }
        );
      }

      if (
        attested.sizeBytes !== undefined &&
        typeof supplied !== "string" &&
        supplied.byteLength !== attested.sizeBytes
      ) {
        return fail(
          "DIGEST_MISMATCH",
          `Byte length mismatch for artifact "${attested.name}"`,
          "Abort deployment; artifact size does not match signed provenance",
          {
            artifactName: attested.name,
            expected: attested.sizeBytes,
            actual: supplied.byteLength,
          }
        );
      }

      verifiedArtifacts.push(attested.name);
    }
  }

  return {
    ok: true,
    keyId: trustedSigner.keyId,
    signer: envelope.signer,
    statementSha256: computedStatementSha256,
    verifiedArtifacts,
  };
}

/**
 * Throwing boundary wrapper over `verifyReleaseProvenance` for callers that
 * prefer fail-fast exception handling.
 */
export function assertValidReleaseProvenance(
  statement: ReleaseProvenanceStatement,
  envelope: ArtifactSignatureEnvelope,
  policy: ProvenanceVerificationPolicy,
  artifacts?: Record<string, Uint8Array | Buffer | string>
): Extract<ProvenanceVerificationResult, { ok: true }> {
  const result = verifyReleaseProvenance(
    statement,
    envelope,
    policy,
    artifacts
  );
  if (!result.ok) {
    throw new ProvenanceError(
      result.code,
      result.message,
      result.recoveryHint,
      result.details
    );
  }
  return result;
}
