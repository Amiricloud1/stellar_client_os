import { describe, it, expect } from "vitest";
import {
  validateCredentials,
  CredentialError,
  isTestnetRpcUrl,
  isMainnetRpcUrl,
  NETWORK_PASSPHRASES,
  type DeploymentCredentials,
  type DeploymentNetwork,
} from "../deployment-credentials.js";

function creds(
  overrides: Partial<DeploymentCredentials> = {}
): DeploymentCredentials {
  return {
    network: "testnet",
    secretKey: "S" + "A".repeat(54) + "Y", // 56 chars, starts with 'S'
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: NETWORK_PASSPHRASES.testnet,
    ...overrides,
  };
}

const VALID_SECRET = "S" + "A".repeat(54) + "Y";

// ── Helpers ────────────────────────────────────────────────────────────────

describe("isTestnetRpcUrl / isMainnetRpcUrl", () => {
  it("identifies testnet RPC URLs", () => {
    expect(isTestnetRpcUrl("https://soroban-testnet.stellar.org")).toBe(true);
    expect(isTestnetRpcUrl("https://rpc.testnet.example")).toBe(true);
    expect(isTestnetRpcUrl("https://horizon.stellar.org")).toBe(false);
    expect(isTestnetRpcUrl("not-a-url")).toBe(false);
  });

  it("identifies mainnet RPC URLs", () => {
    expect(isMainnetRpcUrl("https://soroban-mainnet.stellar.org")).toBe(true);
    expect(isMainnetRpcUrl("https://horizon.stellar.org")).toBe(false);
    expect(isMainnetRpcUrl("https://rpc.testnet.example")).toBe(false);
  });
});

// ── NETWORK_PASSPHRASES ────────────────────────────────────────────────────

describe("NETWORK_PASSPHRASES", () => {
  it("defines distinct passphrases for testnet and mainnet", () => {
    expect(NETWORK_PASSPHRASES.testnet).not.toBe(NETWORK_PASSPHRASES.mainnet);
    expect(NETWORK_PASSPHRASES.testnet).toContain("Test SDF Network");
    expect(NETWORK_PASSPHRASES.mainnet).toContain(
      "Public Global Stellar Network"
    );
  });

  // ── validateCredentials: success ───────────────────────────────────────────

  describe("validateCredentials (success)", () => {
    it("accepts valid testnet credentials against testnet target", () => {
      expect(() =>
        validateCredentials(creds({ network: "testnet" }), "testnet")
      ).not.toThrow();
    });

    it("accepts valid mainnet credentials against mainnet target", () => {
      expect(() =>
        validateCredentials(
          creds({
            network: "mainnet",
            rpcUrl: "https://soroban-mainnet.stellar.org",
            networkPassphrase: NETWORK_PASSPHRASES.mainnet,
          }),
          "mainnet"
        )
      ).not.toThrow();
    });
  });

  // ── validateCredentials: missing fields ────────────────────────────────────

  describe("validateCredentials (missing fields)", () => {
    it.each(["network", "secretKey", "rpcUrl", "networkPassphrase"] as const)(
      "throws MISSING_CREDENTIAL when %s is empty",
      (field) => {
        expect(() =>
          validateCredentials(
            creds({ [field]: "" } as DeploymentCredentials),
            "testnet"
          )
        ).toThrowError(CredentialError);
        try {
          validateCredentials(
            creds({ [field]: "" } as DeploymentCredentials),
            "testnet"
          );
        } catch (err) {
          expect((err as CredentialError).code).toBe("MISSING_CREDENTIAL");
        }
      }
    );
  });

  // ── validateCredentials: invalid secret key ────────────────────────────────

  describe("validateCredentials (invalid secret key)", () => {
    it("throws INVALID_SECRET_KEY when the key does not start with 'S'", () => {
      expect(() =>
        validateCredentials(
          creds({ secretKey: "G" + "A".repeat(54) + "Y" }),
          "testnet"
        )
      ).toThrowError(CredentialError);
      try {
        validateCredentials(
          creds({ secretKey: "G" + "A".repeat(54) + "Y" }),
          "testnet"
        );
      } catch (err) {
        expect((err as CredentialError).code).toBe("INVALID_SECRET_KEY");
      }
    });

    it("throws INVALID_SECRET_KEY when the key is not 56 characters", () => {
      expect(() =>
        validateCredentials(creds({ secretKey: "SHORT" }), "testnet")
      ).toThrowError(CredentialError);
      try {
        validateCredentials(creds({ secretKey: "SHORT" }), "testnet");
      } catch (err) {
        expect((err as CredentialError).code).toBe("INVALID_SECRET_KEY");
      }
    });
  });

  // ── validateCredentials: mismatched network ────────────────────────────────

  describe("validateCredentials (mismatched network)", () => {
    it("throws MISMATCHED_CREDENTIAL when declared network != target network", () => {
      expect(() =>
        validateCredentials(creds({ network: "mainnet" }), "testnet")
      ).toThrowError(CredentialError);
      try {
        validateCredentials(creds({ network: "mainnet" }), "testnet");
      } catch (err) {
        expect((err as CredentialError).code).toBe("MISMATCHED_CREDENTIAL");
      }
    });

    it("throws MISMATCHED_CREDENTIAL when passphrase disagrees with target", () => {
      expect(() =>
        validateCredentials(
          creds({
            network: "mainnet",
            networkPassphrase: NETWORK_PASSPHRASES.testnet,
          }),
          "mainnet"
        )
      ).toThrowError(CredentialError);
      try {
        validateCredentials(
          creds({
            network: "mainnet",
            networkPassphrase: NETWORK_PASSPHRASES.testnet,
          }),
          "mainnet"
        );
      } catch (err) {
        expect((err as CredentialError).code).toBe("MISMATCHED_CREDENTIAL");
      }
    });

    it("throws MISMATCHED_CREDENTIAL for a testnet RPC against mainnet", () => {
      expect(() =>
        validateCredentials(
          creds({
            network: "mainnet",
            rpcUrl: "https://soroban-testnet.stellar.org",
            networkPassphrase: NETWORK_PASSPHRASES.mainnet,
          }),
          "mainnet"
        )
      ).toThrowError(CredentialError);
    });

    it("throws MISMATCHED_CREDENTIAL for a testnet target with a non-testnet RPC", () => {
      expect(() =>
        validateCredentials(
          creds({
            network: "testnet",
            rpcUrl: "https://soroban-mainnet.stellar.org",
          }),
          "testnet"
        )
      ).toThrowError(CredentialError);
    });

    it("throws UNSUPPORTED_NETWORK for an unknown declared network", () => {
      expect(() =>
        validateCredentials(
          creds({ network: "regtest" as DeploymentNetwork }),
          "testnet"
        )
      ).toThrowError(CredentialError);
      try {
        validateCredentials(
          creds({ network: "regtest" as DeploymentNetwork }),
          "testnet"
        );
      } catch (err) {
        expect((err as CredentialError).code).toBe("UNSUPPORTED_NETWORK");
      }
    });
  });
});
