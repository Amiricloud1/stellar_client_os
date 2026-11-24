import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertValidReleaseProvenance,
  canonicalizeProvenanceStatement,
  computeArtifactSha256,
  computePublicKeyId,
  isProvenanceError,
  normalizeArtifactName,
  parseSha256Sums,
  ProvenanceError,
  signReleaseProvenance,
  verifyReleaseProvenance,
  type ProvenanceVerificationPolicy,
  type ReleaseProvenanceStatement,
} from "../provenance.js";

function makeEd25519Keypair(): {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  return {
    privateKeyPem,
    publicKeyPem,
    keyId: computePublicKeyId(publicKeyPem),
  };
}

const STREAM_WASM = Buffer.from("wasm-binary-payment-stream-v1", "utf8");
const DIST_WASM = Buffer.from("wasm-binary-distributor-v1", "utf8");
const COMMIT_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function buildStatement(
  overrides: Partial<ReleaseProvenanceStatement> = {}
): ReleaseProvenanceStatement {
  return {
    schemaVersion: 1,
    commit: COMMIT_SHA,
    ref: "refs/heads/main",
    repository: "Amiricloud1/stellar_client_os",
    target: "wasm32-unknown-unknown",
    profile: "release",
    rustc: "rustc 1.82.0",
    cargo: "cargo 1.82.0",
    checksumAlgorithm: "sha256",
    artifacts: [
      {
        name: "payment_stream.wasm",
        sha256: computeArtifactSha256(STREAM_WASM),
        sizeBytes: STREAM_WASM.byteLength,
      },
      {
        name: "distributor.wasm",
        sha256: computeArtifactSha256(DIST_WASM),
        sizeBytes: DIST_WASM.byteLength,
      },
    ],
    ...overrides,
  };
}

describe("release artifact signing and provenance (#283)", () => {
  it("signs and verifies release provenance with matching artifacts", () => {
    const keypair = makeEd25519Keypair();
    const statement = buildStatement();
    const envelope = signReleaseProvenance(statement, {
      privateKeyPem: keypair.privateKeyPem,
      signer: "github-actions:release",
      signedAt: "2026-11-24T00:00:00.000Z",
    });

    expect(envelope.algorithm).toBe("ed25519");
    expect(envelope.keyId).toBe(keypair.keyId);

    const policy: ProvenanceVerificationPolicy = {
      trustedSigners: [
        {
          keyId: keypair.keyId,
          publicKeyPem: keypair.publicKeyPem,
          allowedRepositories: ["Amiricloud1/stellar_client_os"],
          allowedRefs: ["refs/heads/main", "refs/tags/v*"],
        },
      ],
      expectedRepository: "Amiricloud1/stellar_client_os",
      expectedCommit: COMMIT_SHA,
      allowedRefs: ["refs/heads/main"],
      now: new Date("2026-11-24T01:00:00.000Z"),
    };

    const verified = assertValidReleaseProvenance(statement, envelope, policy, {
      "payment_stream.wasm": STREAM_WASM,
      "./distributor.wasm": DIST_WASM,
    });

    expect(verified.ok).toBe(true);
    expect(verified.keyId).toBe(keypair.keyId);
    expect(verified.verifiedArtifacts).toEqual([
      "distributor.wasm",
      "payment_stream.wasm",
    ]);
  });

  it("canonicalizes statements regardless of key or artifact order", () => {
    const a = buildStatement();
    const b: ReleaseProvenanceStatement = {
      artifacts: [...a.artifacts].reverse(),
      checksumAlgorithm: "sha256",
      profile: a.profile,
      target: a.target,
      repository: a.repository,
      ref: a.ref,
      commit: a.commit.toUpperCase(),
      schemaVersion: 1,
      cargo: a.cargo,
      rustc: a.rustc,
    };

    expect(canonicalizeProvenanceStatement(a)).toBe(
      canonicalizeProvenanceStatement(b)
    );
  });

  it("parses SHA256SUMS and rejects malformed or traversal names", () => {
    const sums = [
      `${computeArtifactSha256(STREAM_WASM)}  ./payment_stream.wasm`,
      `${computeArtifactSha256(DIST_WASM)}  distributor.wasm`,
    ].join("\n");

    const parsed = parseSha256Sums(sums);
    expect(parsed.map((item) => item.name)).toEqual([
      "distributor.wasm",
      "payment_stream.wasm",
    ]);

    expect(() => normalizeArtifactName("../evil.wasm")).toThrowError(
      ProvenanceError
    );
    expect(() => normalizeArtifactName("nested/evil.wasm")).toThrowError(
      ProvenanceError
    );
    expect(() => parseSha256Sums("not-a-valid-line")).toThrowError(
      ProvenanceError
    );
    expect(() => parseSha256Sums("")).toThrowError(ProvenanceError);
  });

  it("detects tampered artifact bytes, metadata edits, and forged keys", () => {
    const trusted = makeEd25519Keypair();
    const attacker = makeEd25519Keypair();
    const statement = buildStatement();
    const envelope = signReleaseProvenance(statement, {
      privateKeyPem: trusted.privateKeyPem,
      signer: "release-bot",
    });

    const policy: ProvenanceVerificationPolicy = {
      trustedSigners: [
        { keyId: trusted.keyId, publicKeyPem: trusted.publicKeyPem },
      ],
    };

    // Tampered artifact bytes -> DIGEST_MISMATCH
    const tamperedArtifact = verifyReleaseProvenance(
      statement,
      envelope,
      policy,
      {
        "payment_stream.wasm": Buffer.from("tampered-bytes", "utf8"),
        "distributor.wasm": DIST_WASM,
      }
    );
    expect(tamperedArtifact.ok).toBe(false);
    if (!tamperedArtifact.ok) {
      expect(tamperedArtifact.code).toBe("DIGEST_MISMATCH");
    }

    // Tampered statement commit -> DIGEST_MISMATCH
    const editedStatement = buildStatement({
      commit: "ffffffffffffffffffffffffffffffffffffffff",
    });
    const editedRes = verifyReleaseProvenance(
      editedStatement,
      envelope,
      policy
    );
    expect(editedRes.ok).toBe(false);
    if (!editedRes.ok) {
      expect(editedRes.code).toBe("DIGEST_MISMATCH");
    }

    // Forged signature using attacker key claiming trusted keyId -> SIGNATURE_INVALID
    const forgedEnvelope = signReleaseProvenance(statement, {
      privateKeyPem: attacker.privateKeyPem,
      signer: "attacker",
      keyId: trusted.keyId,
    });
    const forgedRes = verifyReleaseProvenance(
      statement,
      forgedEnvelope,
      policy
    );
    expect(forgedRes.ok).toBe(false);
    if (!forgedRes.ok) {
      expect(forgedRes.code).toBe("SIGNATURE_INVALID");
    }
  });

  it("enforces signer trust, policy scopes, and artifact completeness", () => {
    const keypair = makeEd25519Keypair();
    const otherKey = makeEd25519Keypair();
    const statement = buildStatement();
    const envelope = signReleaseProvenance(statement, {
      privateKeyPem: keypair.privateKeyPem,
      signer: "release-bot",
    });

    // Untrusted signer
    const untrusted = verifyReleaseProvenance(statement, envelope, {
      trustedSigners: [
        { keyId: otherKey.keyId, publicKeyPem: otherKey.publicKeyPem },
      ],
    });
    expect(untrusted.ok).toBe(false);
    if (!untrusted.ok) {
      expect(untrusted.code).toBe("UNTRUSTED_SIGNER");
    }

    // Unauthorized repository
    const wrongRepo = verifyReleaseProvenance(statement, envelope, {
      trustedSigners: [
        { keyId: keypair.keyId, publicKeyPem: keypair.publicKeyPem },
      ],
      expectedRepository: "OtherOrg/other_repo",
    });
    expect(wrongRepo.ok).toBe(false);
    if (!wrongRepo.ok) {
      expect(wrongRepo.code).toBe("UNAUTHORIZED_REPOSITORY");
    }

    // Unauthorized ref
    const wrongRef = verifyReleaseProvenance(statement, envelope, {
      trustedSigners: [
        { keyId: keypair.keyId, publicKeyPem: keypair.publicKeyPem },
      ],
      allowedRefs: ["refs/tags/v*"],
    });
    expect(wrongRef.ok).toBe(false);
    if (!wrongRef.ok) {
      expect(wrongRef.code).toBe("UNAUTHORIZED_REF");
    }

    // Commit mismatch
    const wrongCommit = verifyReleaseProvenance(statement, envelope, {
      trustedSigners: [
        { keyId: keypair.keyId, publicKeyPem: keypair.publicKeyPem },
      ],
      expectedCommit: "0000000000000000000000000000000000000000",
    });
    expect(wrongCommit.ok).toBe(false);
    if (!wrongCommit.ok) {
      expect(wrongCommit.code).toBe("COMMIT_MISMATCH");
    }

    // Missing artifact
    const missing = verifyReleaseProvenance(
      statement,
      envelope,
      {
        trustedSigners: [
          { keyId: keypair.keyId, publicKeyPem: keypair.publicKeyPem },
        ],
      },
      { "payment_stream.wasm": STREAM_WASM }
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("MISSING_ARTIFACT");
    }

    // Unexpected extra artifact
    const extra = verifyReleaseProvenance(
      statement,
      envelope,
      {
        trustedSigners: [
          { keyId: keypair.keyId, publicKeyPem: keypair.publicKeyPem },
        ],
      },
      {
        "payment_stream.wasm": STREAM_WASM,
        "distributor.wasm": DIST_WASM,
        "backdoor.wasm": Buffer.from("unexpected", "utf8"),
      }
    );
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.code).toBe("UNEXPECTED_ARTIFACT");
    }
  });

  it("blocks revoked or expired keys and recovers via key rotation", () => {
    const oldKey = makeEd25519Keypair();
    const newKey = makeEd25519Keypair();
    const statement = buildStatement();

    const oldEnvelope = signReleaseProvenance(statement, {
      privateKeyPem: oldKey.privateKeyPem,
      signer: "release-bot",
      signedAt: "2026-11-24T00:00:00.000Z",
    });

    // Revoked key fails closed with explicit recovery hint.
    const revokedRes = verifyReleaseProvenance(statement, oldEnvelope, {
      trustedSigners: [
        {
          keyId: oldKey.keyId,
          publicKeyPem: oldKey.publicKeyPem,
          revoked: true,
        },
        { keyId: newKey.keyId, publicKeyPem: newKey.publicKeyPem },
      ],
    });
    expect(revokedRes.ok).toBe(false);
    if (!revokedRes.ok) {
      expect(revokedRes.code).toBe("SIGNER_REVOKED");
      expect(revokedRes.recoveryHint).toMatch(/rotate/i);
    }

    // Expired key fails closed.
    const expiredRes = verifyReleaseProvenance(statement, oldEnvelope, {
      trustedSigners: [
        {
          keyId: oldKey.keyId,
          publicKeyPem: oldKey.publicKeyPem,
          expiresAt: "2026-11-20T00:00:00.000Z",
        },
      ],
      now: new Date("2026-11-24T01:00:00.000Z"),
    });
    expect(expiredRes.ok).toBe(false);
    if (!expiredRes.ok) {
      expect(expiredRes.code).toBe("SIGNER_EXPIRED");
    }

    // Re-signing with rotated active key recovers cleanly.
    const rotatedEnvelope = signReleaseProvenance(statement, {
      privateKeyPem: newKey.privateKeyPem,
      signer: "release-bot",
      signedAt: "2026-11-24T01:00:00.000Z",
    });
    const recovered = assertValidReleaseProvenance(statement, rotatedEnvelope, {
      trustedSigners: [
        {
          keyId: oldKey.keyId,
          publicKeyPem: oldKey.publicKeyPem,
          revoked: true,
        },
        { keyId: newKey.keyId, publicKeyPem: newKey.publicKeyPem },
      ],
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.keyId).toBe(newKey.keyId);
  });

  it("rejects invalid signing keys and malformed statements explicitly", () => {
    const statement = buildStatement();
    try {
      signReleaseProvenance(statement, {
        privateKeyPem: "not-a-valid-key",
        signer: "release-bot",
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(isProvenanceError(error)).toBe(true);
      if (isProvenanceError(error)) {
        expect(error.code).toBe("SIGNING_KEY_INVALID");
      }
    }

    expect(() =>
      canonicalizeProvenanceStatement(buildStatement({ artifacts: [] }))
    ).toThrowError(ProvenanceError);
  });
});
