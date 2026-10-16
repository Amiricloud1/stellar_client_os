/**
 * Deployment credential custody and network separation — issue #108
 *
 * Validates deployment credentials before any contract is deployed. Rejects
 * missing or mismatched credentials so a testnet credential can never be used
 * against mainnet (or vice versa), and enforces that the declared network,
 * RPC URL, and network passphrase all agree.
 *
 * This module is pure (no network, no secrets written to disk) so it can be
 * tested deterministically and run as a preflight check in CI before
 * `scripts/deploy.sh` touches the network.
 *
 * Companion operator guidance lives in docs/deployment-credentials.md.
 */

export type DeploymentNetwork = "testnet" | "mainnet";

export interface DeploymentCredentials {
  /** Target network for the deployment. */
  network: DeploymentNetwork;
  /** Stellar secret key of the deployer account (starts with 'S', 56 chars). */
  secretKey: string;
  /** RPC endpoint used to submit deployment transactions. */
  rpcUrl: string;
  /** Network passphrase that must match the target network. */
  networkPassphrase: string;
}

/** Error raised when credentials are missing, invalid, or mismatched. */
export class CredentialError extends Error {
  public readonly code:
    | "MISSING_CREDENTIAL"
    | "INVALID_SECRET_KEY"
    | "UNSUPPORTED_NETWORK"
    | "MISMATCHED_CREDENTIAL";

  constructor(message: string, code: CredentialError["code"]) {
    super(message);
    this.name = "CredentialError";
    this.code = code;
    Object.setPrototypeOf(this, CredentialError.prototype);
  }
}

/** Expected network passphrase per network. */
export const NETWORK_PASSPHRASES: Record<DeploymentNetwork, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
};

const STELLAR_SECRET_KEY_PREFIX = "S";
const STELLAR_SECRET_KEY_LENGTH = 56;

/** Required credential fields. */
const REQUIRED_FIELDS: (keyof DeploymentCredentials)[] = [
  "network",
  "secretKey",
  "rpcUrl",
  "networkPassphrase",
];

/**
 * Returns true when the RPC URL looks like a testnet endpoint (hostname
 * contains "testnet").
 */
export function isTestnetRpcUrl(rpcUrl: string): boolean {
  try {
    return new URL(rpcUrl).hostname.includes("testnet");
  } catch {
    return false;
  }
}

/**
 * Returns true when the RPC URL looks like a mainnet endpoint (hostname
 * contains "mainnet" and does not look like a testnet endpoint).
 */
export function isMainnetRpcUrl(rpcUrl: string): boolean {
  try {
    const hostname = new URL(rpcUrl).hostname;
    return hostname.includes("mainnet") && !hostname.includes("testnet");
  } catch {
    return false;
  }
}

/**
 * Validate deployment credentials against a target network.
 *
 * Throws CredentialError when:
 * - any required field is missing or empty (MISSING_CREDENTIAL)
 * - the secret key is not a valid Stellar secret key (INVALID_SECRET_KEY)
 * - the declared network is not testnet/mainnet (UNSUPPORTED_NETWORK)
 * - the credentials do not match the target network (MISMATCHED_CREDENTIAL):
 *   declared network != target network, or network passphrase / RPC URL
 *   disagree with the target network.
 *
 * Returns undefined when credentials are valid.
 */
export function validateCredentials(
  creds: DeploymentCredentials,
  targetNetwork: DeploymentNetwork
): void {
  for (const field of REQUIRED_FIELDS) {
    const value = creds[field];
    if (value === undefined || value === null || String(value).trim() === "") {
      throw new CredentialError(
        `Missing required deployment credential: ${field}`,
        "MISSING_CREDENTIAL"
      );
    }
  }

  if (
    typeof creds.network !== "string" ||
    (creds.network !== "testnet" && creds.network !== "mainnet")
  ) {
    throw new CredentialError(
      `Unsupported network: ${creds.network}. Expected "testnet" or "mainnet".`,
      "UNSUPPORTED_NETWORK"
    );
  }

  // Secret key format: Stellar secret keys start with 'S' and are 56 chars.
  if (
    typeof creds.secretKey !== "string" ||
    !creds.secretKey.startsWith(STELLAR_SECRET_KEY_PREFIX) ||
    creds.secretKey.length !== STELLAR_SECRET_KEY_LENGTH
  ) {
    throw new CredentialError(
      `Invalid Stellar secret key: must start with '${STELLAR_SECRET_KEY_PREFIX}' and be ${STELLAR_SECRET_KEY_LENGTH} characters`,
      "INVALID_SECRET_KEY"
    );
  }

  // Declared network must match the target network.
  if (creds.network !== targetNetwork) {
    throw new CredentialError(
      `Credential network "${creds.network}" does not match target network "${targetNetwork}"`,
      "MISMATCHED_CREDENTIAL"
    );
  }

  // Network passphrase must match the target network.
  const expectedPassphrase = NETWORK_PASSPHRASES[targetNetwork];
  if (creds.networkPassphrase !== expectedPassphrase) {
    throw new CredentialError(
      `Network passphrase does not match the ${targetNetwork} network`,
      "MISMATCHED_CREDENTIAL"
    );
  }

  // RPC URL must be consistent with the target network.
  if (targetNetwork === "testnet" && !isTestnetRpcUrl(creds.rpcUrl)) {
    throw new CredentialError(
      `RPC URL "${creds.rpcUrl}" is not a testnet endpoint`,
      "MISMATCHED_CREDENTIAL"
    );
  }
  if (targetNetwork === "mainnet" && isTestnetRpcUrl(creds.rpcUrl)) {
    throw new CredentialError(
      `RPC URL "${creds.rpcUrl}" is a testnet endpoint; cannot deploy to mainnet`,
      "MISMATCHED_CREDENTIAL"
    );
  }
}
