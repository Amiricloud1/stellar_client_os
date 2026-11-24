#!/usr/bin/env node
/**
 * Release artifact signing and provenance verification CLI (issue #283).
 *
 * Dependency-free Node.js script used by `.github/workflows/release.yml` and
 * operators to sign `provenance.json` with Ed25519 and verify signatures plus
 * SHA-256 artifact digests before release publication or deployment.
 *
 * Commands:
 *   node scripts/release-provenance.mjs sign \
 *     --statement dist/wasm/provenance.json \
 *     --out dist/wasm/provenance.sig.json \
 *     --signer github-actions-release \
 *     [--key-env RELEASE_SIGNING_PRIVATE_KEY]
 *
 *   node scripts/release-provenance.mjs verify \
 *     --statement dist/wasm/provenance.json \
 *     --signature dist/wasm/provenance.sig.json \
 *     --dir dist/wasm \
 *     [--public-key-file key.pub.pem | --public-key-env RELEASE_SIGNING_PUBLIC_KEY] \
 *     [--expected-repo owner/repo] \
 *     [--expected-commit <40-hex-sha>] \
 *     [--allowed-ref refs/heads/main]
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = 1;
const SIGNATURE_DOMAIN = "fundable-release-provenance-v1";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/i;
const REPOSITORY_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9._-]+$/;

function canonicalizeValue(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeValue(item)).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalizeValue(value[key])}`)
    .join(",")}}`;
}

function normalizeArtifactName(rawName) {
  const trimmed = String(rawName ?? "").trim();
  const stripped = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  if (
    !stripped ||
    stripped.includes("..") ||
    stripped.includes("/") ||
    stripped.includes("\\") ||
    !SAFE_ARTIFACT_NAME.test(stripped)
  ) {
    throw new Error(`INVALID_STATEMENT: unsafe artifact filename "${rawName}"`);
  }
  return stripped;
}

function normalizeStatement(statement) {
  if (!statement || typeof statement !== "object") {
    throw new Error("INVALID_STATEMENT: provenance statement must be an object");
  }
  if (statement.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `INVALID_STATEMENT: unsupported schemaVersion ${String(statement.schemaVersion)}`
    );
  }
  if (
    typeof statement.commit !== "string" ||
    !GIT_COMMIT.test(statement.commit)
  ) {
    throw new Error("INVALID_STATEMENT: invalid 40-char git commit SHA");
  }
  if (typeof statement.ref !== "string" || !statement.ref.trim()) {
    throw new Error("INVALID_STATEMENT: missing ref");
  }
  if (
    typeof statement.repository !== "string" ||
    !REPOSITORY_SLUG.test(statement.repository)
  ) {
    throw new Error("INVALID_STATEMENT: invalid owner/repo repository slug");
  }
  if (statement.checksumAlgorithm !== "sha256") {
    throw new Error("INVALID_STATEMENT: checksumAlgorithm must be sha256");
  }
  if (!Array.isArray(statement.artifacts) || statement.artifacts.length === 0) {
    throw new Error("INVALID_STATEMENT: artifacts list must be non-empty");
  }

  const seen = new Set();
  const artifacts = statement.artifacts.map((artifact) => {
    const name = normalizeArtifactName(artifact.name);
    if (seen.has(name)) {
      throw new Error(`INVALID_STATEMENT: duplicate artifact "${name}"`);
    }
    seen.add(name);
    const sha256 = String(artifact.sha256 ?? "")
      .trim()
      .toLowerCase();
    if (!SHA256_HEX.test(sha256)) {
      throw new Error(`INVALID_STATEMENT: invalid sha256 for "${name}"`);
    }
    return {
      name,
      sha256,
      ...(artifact.sizeBytes !== undefined
        ? { sizeBytes: artifact.sizeBytes }
        : {}),
    };
  });
  artifacts.sort((a, b) => a.name.localeCompare(b.name));

  return {
    ...statement,
    commit: statement.commit.toLowerCase(),
    artifacts,
  };
}

function decodePemMaterial(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.includes("-----BEGIN ")) {
    return trimmed.replace(/\\n/g, "\n");
  }
  const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
  return decoded.includes("-----BEGIN ") ? decoded : trimmed;
}

function computePublicKeyId(publicKeyPem) {
  const keyObj = createPublicKey(publicKeyPem);
  if (keyObj.asymmetricKeyType !== "ed25519") {
    throw new Error("SIGNING_KEY_INVALID: expected Ed25519 public key");
  }
  const der = keyObj.export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex").slice(0, 16)}`;
}

function constantTimeHexEqual(a, b) {
  const bufA = Buffer.from(a.toLowerCase(), "utf8");
  const bufB = Buffer.from(b.toLowerCase(), "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function parseArgs(argv) {
  const command = argv[0];
  const flags = {};
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = "true";
      } else {
        flags[key] = next;
        i += 1;
      }
    }
  }
  return { command, flags };
}

function runSign(flags) {
  const statementPath = flags.statement;
  const outPath = flags.out;
  const signer = flags.signer || "github-actions-release";
  const keyEnv = flags["key-env"] || "RELEASE_SIGNING_PRIVATE_KEY";

  if (!statementPath || !outPath) {
    throw new Error(
      "Usage: sign --statement <provenance.json> --out <provenance.sig.json>"
    );
  }

  const rawKey = flags["key-file"]
    ? fs.readFileSync(flags["key-file"], "utf8")
    : process.env[keyEnv];
  const privateKeyPem = decodePemMaterial(rawKey);
  if (!privateKeyPem) {
    throw new Error(
      `SIGNING_KEY_INVALID: signing key not provided (set ${keyEnv} or --key-file)`
    );
  }

  const rawStatement = JSON.parse(fs.readFileSync(statementPath, "utf8"));
  const normalized = normalizeStatement(rawStatement);
  const canonicalStatement = canonicalizeValue(normalized);

  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("SIGNING_KEY_INVALID: private key must be Ed25519");
  }
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  const keyId = flags["key-id"] || computePublicKeyId(publicKeyPem);
  const statementSha256 = createHash("sha256")
    .update(canonicalStatement, "utf8")
    .digest("hex");
  const payload = Buffer.from(
    `${SIGNATURE_DOMAIN}\n${canonicalStatement}`,
    "utf8"
  );
  const signature = sign(null, payload, privateKey).toString("base64");

  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    algorithm: "ed25519",
    keyId,
    signer,
    signedAt: new Date().toISOString(),
    statementSha256,
    signature,
  };

  fs.writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  console.log(
    `Signed ${statementPath} -> ${outPath} (keyId=${keyId}, statementSha256=${statementSha256})`
  );
}

function runVerify(flags) {
  const statementPath = flags.statement;
  const signaturePath = flags.signature;
  const artifactDir = flags.dir;
  const pubKeyEnv = flags["public-key-env"] || "RELEASE_SIGNING_PUBLIC_KEY";

  if (!statementPath || !signaturePath) {
    throw new Error(
      "Usage: verify --statement <provenance.json> --signature <provenance.sig.json> [--dir <artifact-dir>]"
    );
  }

  const rawPubKey = flags["public-key-file"]
    ? fs.readFileSync(flags["public-key-file"], "utf8")
    : process.env[pubKeyEnv];
  const publicKeyPem = decodePemMaterial(rawPubKey);
  if (!publicKeyPem) {
    throw new Error(
      `SIGNING_KEY_INVALID: public key not provided (set ${pubKeyEnv} or --public-key-file)`
    );
  }

  const rawStatement = JSON.parse(fs.readFileSync(statementPath, "utf8"));
  const envelope = JSON.parse(fs.readFileSync(signaturePath, "utf8"));
  const normalized = normalizeStatement(rawStatement);
  const canonicalStatement = canonicalizeValue(normalized);

  if (
    !envelope ||
    envelope.schemaVersion !== SCHEMA_VERSION ||
    envelope.algorithm !== "ed25519"
  ) {
    throw new Error(
      "INVALID_SIGNATURE_ENVELOPE: expected schemaVersion 1 and ed25519 algorithm"
    );
  }

  const expectedKeyId = computePublicKeyId(publicKeyPem);
  if (flags["key-id"] && envelope.keyId !== flags["key-id"]) {
    throw new Error(
      `UNTRUSTED_SIGNER: envelope keyId "${envelope.keyId}" does not match expected "${flags["key-id"]}"`
    );
  }
  if (!flags["key-id"] && envelope.keyId !== expectedKeyId) {
    throw new Error(
      `UNTRUSTED_SIGNER: envelope keyId "${envelope.keyId}" does not match public key fingerprint "${expectedKeyId}"`
    );
  }

  if (
    flags["expected-repo"] &&
    normalized.repository !== flags["expected-repo"]
  ) {
    throw new Error(
      `UNAUTHORIZED_REPOSITORY: expected "${flags["expected-repo"]}", got "${normalized.repository}"`
    );
  }
  if (
    flags["expected-commit"] &&
    !constantTimeHexEqual(normalized.commit, flags["expected-commit"])
  ) {
    throw new Error(
      `COMMIT_MISMATCH: expected "${flags["expected-commit"]}", got "${normalized.commit}"`
    );
  }
  if (flags["allowed-ref"] && normalized.ref !== flags["allowed-ref"]) {
    throw new Error(
      `UNAUTHORIZED_REF: ref "${normalized.ref}" does not match allowed "${flags["allowed-ref"]}"`
    );
  }

  const computedStatementSha256 = createHash("sha256")
    .update(canonicalStatement, "utf8")
    .digest("hex");
  if (!constantTimeHexEqual(computedStatementSha256, envelope.statementSha256)) {
    throw new Error(
      "DIGEST_MISMATCH: provenance statement digest does not match signed envelope"
    );
  }

  const publicKey = createPublicKey(publicKeyPem);
  const payload = Buffer.from(
    `${SIGNATURE_DOMAIN}\n${canonicalStatement}`,
    "utf8"
  );
  const sigBytes = Buffer.from(String(envelope.signature ?? ""), "base64");
  if (sigBytes.length !== 64 || !verify(null, payload, publicKey, sigBytes)) {
    throw new Error("SIGNATURE_INVALID: Ed25519 signature verification failed");
  }

  if (artifactDir) {
    for (const artifact of normalized.artifacts) {
      const fullPath = path.join(artifactDir, artifact.name);
      if (!fs.existsSync(fullPath)) {
        throw new Error(
          `MISSING_ARTIFACT: attested artifact "${artifact.name}" not found in ${artifactDir}`
        );
      }
      const bytes = fs.readFileSync(fullPath);
      const actualSha256 = createHash("sha256").update(bytes).digest("hex");
      if (!constantTimeHexEqual(actualSha256, artifact.sha256)) {
        throw new Error(
          `DIGEST_MISMATCH: artifact "${artifact.name}" digest mismatch (expected ${artifact.sha256}, got ${actualSha256})`
        );
      }
    }
  }

  console.log(
    `Verified release provenance for ${normalized.artifacts.length} artifact(s) (keyId=${envelope.keyId}, commit=${normalized.commit})`
  );
}

try {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === "sign") {
    runSign(flags);
  } else if (command === "verify") {
    runVerify(flags);
  } else {
    throw new Error('Expected command "sign" or "verify"');
  }
} catch (error) {
  console.error(
    `✗ release-provenance failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}
