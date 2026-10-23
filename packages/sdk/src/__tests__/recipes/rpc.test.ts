import { describe, it, expect } from "vitest";
import {
  getRpcProviderConfig,
  getRpcServerOptions,
  isLocalRpcUrl,
  STELLAR_NETWORKS,
  type StellarNetwork,
} from "../../recipes/rpc.js";

describe("STELLAR_NETWORKS", () => {
  it("defines testnet, mainnet, and local presets", () => {
    expect(STELLAR_NETWORKS.testnet).toBeDefined();
    expect(STELLAR_NETWORKS.mainnet).toBeDefined();
    expect(STELLAR_NETWORKS.local).toBeDefined();
  });

  it("testnet has correct passphrase and RPC URL", () => {
    expect(STELLAR_NETWORKS.testnet.networkPassphrase).toBe(
      "Test SDF Network ; September 2015",
    );
    expect(STELLAR_NETWORKS.testnet.rpcUrl).toBe(
      "https://soroban-testnet.stellar.org",
    );
  });

  it("mainnet has correct passphrase and RPC URL", () => {
    expect(STELLAR_NETWORKS.mainnet.networkPassphrase).toBe(
      "Public Global Stellar Network ; September 2015",
    );
    expect(STELLAR_NETWORKS.mainnet.rpcUrl).toBe(
      "https://soroban-mainnet.stellar.org",
    );
  });
});

describe("getRpcProviderConfig", () => {
  it("returns testnet config with defaults", () => {
    const config = getRpcProviderConfig("testnet");

    expect(config.network).toBe("testnet");
    expect(config.networkPassphrase).toBe("Test SDF Network ; September 2015");
    expect(config.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(config.allowHttp).toBe(false);
  });

  it("returns mainnet config with defaults", () => {
    const config = getRpcProviderConfig("mainnet");

    expect(config.network).toBe("mainnet");
    expect(config.networkPassphrase).toBe(
      "Public Global Stellar Network ; September 2015",
    );
    expect(config.rpcUrl).toBe("https://soroban-mainnet.stellar.org");
    expect(config.allowHttp).toBe(false);
  });

  it("returns local config with allowHttp true", () => {
    const config = getRpcProviderConfig("local");

    expect(config.network).toBe("local");
    expect(config.networkPassphrase).toBe("Standalone Network ; February 2017");
    expect(config.rpcUrl).toBe("http://localhost:8000");
    expect(config.allowHttp).toBe(true);
  });

  it("applies overrides", () => {
    const config = getRpcProviderConfig("testnet", {
      rpcUrl: "https://custom-rpc.example.com",
    });

    expect(config.rpcUrl).toBe("https://custom-rpc.example.com");
    expect(config.network).toBe("testnet");
  });

  it("throws on unknown network", () => {
    expect(() => getRpcProviderConfig("unknown" as StellarNetwork)).toThrow(
      /Unknown Stellar network/,
    );
  });
});

describe("getRpcServerOptions", () => {
  it("returns allowHttp false for https URLs", () => {
    const options = getRpcServerOptions("https://soroban-testnet.stellar.org");
    expect(options).toEqual({ allowHttp: false });
  });

  it("returns allowHttp true for loopback http with opt-in", () => {
    const options = getRpcServerOptions("http://localhost:8000", true);
    expect(options).toEqual({ allowHttp: true });
  });

  it("throws for non-loopback http without allowHttp", () => {
    expect(() =>
      getRpcServerOptions("http://evil.example/rpc"),
    ).toThrow(/Insecure RPC URL/);
  });
});

describe("isLocalRpcUrl", () => {
  it.each([
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://[::1]:8000",
  ])("returns true for %s", (url) => {
    expect(isLocalRpcUrl(url)).toBe(true);
  });

  it.each([
    "https://localhost:8000",
    "http://example.com",
    "http://192.168.1.1",
    "https://soroban-testnet.stellar.org",
  ])("returns false for %s", (url) => {
    expect(isLocalRpcUrl(url)).toBe(false);
  });
});