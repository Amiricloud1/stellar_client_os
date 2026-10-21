import { afterEach, describe, expect, it, vi } from "vitest";
import { reportCaughtError, reportRuntimeError, scrubSentryEvent } from "./error-reporting";

const { captureException, setContext, initCalls } = vi.hoisted(() => ({
  captureException: vi.fn(),
  setContext: vi.fn(),
  initCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@sentry/nextjs", () => ({
  captureException,
  captureRouterTransitionStart: vi.fn(),
  init: vi.fn((config: Record<string, unknown>) => {
    initCalls.push(config);
  }),
  withScope: (callback: (scope: { setContext: typeof setContext }) => void) =>
    callback({ setContext }),
}));

describe("error reporting & Sentry pre-transmission scrubbing (#83)", () => {
  const secretKey = `S${"B".repeat(55)}`;
  const publicKey = `G${"A".repeat(55)}`;
  const signedXdr =
    "AAAAAgAAAABi1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/==";

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("captures a sanitized runtime error in Sentry", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://example@sentry.invalid/1");

    reportRuntimeError(new Error(`Wallet lookup failed for ${publicKey}`), {
      boundaryName: "root-layout",
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    const [captured] = captureException.mock.calls[0] as [Error];
    expect(captured.message).not.toContain(publicKey);
    expect(captured.message).toContain("GAAA...AAAAA");
    expect(setContext).toHaveBeenCalledWith("fundable", {
      boundaryName: "root-layout",
      componentStack: undefined,
    });
  });

  it("captures caught errors without replacing the custom fallback contract", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://example@sentry.invalid/1");

    reportCaughtError(new Error("Request failed"), { route: "/api/streams" });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Request failed" })
    );
    expect(setContext).toHaveBeenCalledWith("fundable", { route: "/api/streams" });
  });

  it("scrubs tax IDs, wallet secrets, signed transactions, and evidence before calling Sentry", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://example@sentry.invalid/1");

    reportCaughtError(
      new Error(
        `Verification failed for EIN 12-3456789, secret ${secretKey}, tx ${signedXdr}, evidence ipfs://QmProof999`
      ),
      {
        taxId: "12-3456789",
        secretKey,
        signedXdr,
        verificationEvidence: { ipfsCid: "QmProof999", latitude: 1.23, longitude: 4.56 },
        password: "secret-password",
        route: "/api/campaigns/verify",
      }
    );

    expect(captureException).toHaveBeenCalledTimes(1);
    const [captured] = captureException.mock.calls[0] as [Error];
    expect(captured.message).not.toContain("12-3456789");
    expect(captured.message).not.toContain(secretKey);
    expect(captured.message).not.toContain(signedXdr);
    expect(captured.message).not.toContain("QmProof999");
    expect(captured.message).toContain("[TAX_ID_REDACTED]");
    expect(captured.message).toContain("[SECRET_KEY_REDACTED]");
    expect(captured.message).toContain("[SIGNED_TX_REDACTED]");
    expect(captured.message).toContain("[EVIDENCE_REDACTED]");

    expect(setContext).toHaveBeenCalledWith("fundable", {
      taxId: "[TAX_ID_REDACTED]",
      secretKey: "[SECRET_KEY_REDACTED]",
      signedXdr: "[SIGNED_TX_REDACTED]",
      verificationEvidence: "[EVIDENCE_REDACTED]",
      password: "[REDACTED]",
      route: "/api/campaigns/verify",
    });
  });

  it("wires beforeSend and beforeBreadcrumb scrubbing in client, server, and edge Sentry configs", async () => {
    initCalls.length = 0;
    await import("@/instrumentation-client");
    await import("@/sentry.server.config");
    await import("@/sentry.edge.config");

    expect(initCalls.length).toBeGreaterThanOrEqual(3);
    for (const config of initCalls) {
      expect(typeof config.beforeSend).toBe("function");
      expect(typeof config.beforeSendTransaction).toBe("function");
      expect(typeof config.beforeBreadcrumb).toBe("function");

      const beforeSend = config.beforeSend as (ev: Record<string, unknown>) => Record<string, unknown>;
      const scrubbed = beforeSend({
        message: `Tax ID 12-3456789 and ${secretKey}`,
        request: {
          url: `https://app.fundable.org/verify?taxId=12-3456789&signedXdr=${signedXdr}`,
          data: {
            ein: "12-3456789",
            walletSecret: secretKey,
            txXdr: signedXdr,
            evidenceUrl: "ipfs://QmHash",
          },
        },
      });

      expect(scrubbed.message).toBe("Tax ID [TAX_ID_REDACTED] and [SECRET_KEY_REDACTED]");
      const req = scrubbed.request as Record<string, unknown>;
      expect(req.url).toContain("taxId=[TAX_ID_REDACTED]");
      expect(req.url).toContain("signedXdr=[SIGNED_TX_REDACTED]");
      expect(req.data).toEqual({
        ein: "[TAX_ID_REDACTED]",
        walletSecret: "[SECRET_KEY_REDACTED]",
        txXdr: "[SIGNED_TX_REDACTED]",
        evidenceUrl: "[EVIDENCE_REDACTED]",
      });
    }

    expect(typeof scrubSentryEvent).toBe("function");
  });

  it("does not call Sentry when no DSN is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");

    reportCaughtError(new Error("No DSN"));

    expect(captureException).not.toHaveBeenCalled();
  });
});
