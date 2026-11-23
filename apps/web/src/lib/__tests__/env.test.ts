// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateEnv, env, PAYMENT_STREAM_CONTRACT_ID, DISTRIBUTOR_CONTRACT_ID } from "../env";

const VALID_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

function setRequiredContractIds(): void {
  process.env.NEXT_PUBLIC_PAYMENT_STREAM_CONTRACT_ID = VALID_CONTRACT_ID;
  process.env.NEXT_PUBLIC_DISTRIBUTOR_CONTRACT_ID = VALID_CONTRACT_ID;
}

describe("Environment Variable Validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should throw error when required contract IDs are missing", () => {
    delete process.env.NEXT_PUBLIC_PAYMENT_STREAM_CONTRACT_ID;
    delete process.env.NEXT_PUBLIC_DISTRIBUTOR_CONTRACT_ID;
    expect(() => validateEnv()).toThrow(/Environment variable validation failed/);
  });

  it("should throw error when contract IDs don't start with C", () => {
    process.env.NEXT_PUBLIC_PAYMENT_STREAM_CONTRACT_ID = "INVALID123";
    process.env.NEXT_PUBLIC_DISTRIBUTOR_CONTRACT_ID = VALID_CONTRACT_ID;
    expect(() => validateEnv()).toThrow(/valid Stellar contract address/);
  });

  it("should throw error when network is invalid", () => {
    setRequiredContractIds();
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "invalid";
    expect(() => validateEnv()).toThrow(/Network must be either 'testnet' or 'mainnet'/);
  });

  it("should accept valid environment variables", () => {
    setRequiredContractIds();
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "testnet";
    expect(() => validateEnv()).not.toThrow();
  });

  it("should use default values for optional variables", () => {
    setRequiredContractIds();
    expect(() => validateEnv()).not.toThrow();
  });

  it("rejects a passphrase or RPC origin that disagrees with the selected network", () => {
    setRequiredContractIds();
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "mainnet";
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

    expect(() => validateEnv()).toThrow(/Network passphrase does not match/);
  });

  it("rejects a mainnet passphrase paired with a testnet RPC origin", () => {
    setRequiredContractIds();
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "mainnet";
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015";
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

    expect(() => validateEnv()).toThrow(/RPC endpoint origin does not match/);
  });

  it("accepts only canonical app origins rather than arbitrary page URLs", () => {
    setRequiredContractIds();
    process.env.NEXT_PUBLIC_URL = "https://app.example.org/admin";

    expect(() => validateEnv()).toThrow(/credential-free HTTPS origin/);
  });

  it("rejects unsafe origins without exposing configured credentials in diagnostics", () => {
    setRequiredContractIds();
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL = "https://rpc.example.test/?token=do-not-log";

    let message = "";
    try {
      validateEnv();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/without embedded credentials or query secrets/);
    expect(message).not.toContain("do-not-log");
  });

  it("rejects secret-bearing NEXT_PUBLIC variables without displaying their values", () => {
    setRequiredContractIds();
    process.env.NEXT_PUBLIC_ADMIN_API_KEY = "private-value-that-must-not-leak";

    let message = "";
    try {
      validateEnv();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("NEXT_PUBLIC_ADMIN_API_KEY");
    expect(message).not.toContain("private-value-that-must-not-leak");
  });

  it("rejects unresolved webhook secret references without echoing the reference", () => {
    setRequiredContractIds();
    process.env.WEBHOOK_SIGNING_SECRET = "${WEBHOOK_SIGNING_SECRET}";

    let message = "";
    try {
      validateEnv();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/resolved secret value/);
    expect(message).not.toContain("${WEBHOOK_SIGNING_SECRET}");
  });

  it("rejects unresolved external secret-manager references by name only", () => {
    setRequiredContractIds();
    process.env.AWS_SECRET_ACCESS_KEY = "arn:aws:secretsmanager:region:account:secret:key";

    let message = "";
    try {
      validateEnv();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("AWS_SECRET_ACCESS_KEY");
    expect(message).not.toContain("arn:aws:secretsmanager");
  });

  it("should export contract IDs from the env module", () => {
    expect(PAYMENT_STREAM_CONTRACT_ID).toBe(env.NEXT_PUBLIC_PAYMENT_STREAM_CONTRACT_ID);
    expect(DISTRIBUTOR_CONTRACT_ID).toBe(env.NEXT_PUBLIC_DISTRIBUTOR_CONTRACT_ID);
  });
});
