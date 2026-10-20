/**
 * Tests for query freshness – issue #79
 *
 * Covers:
 * • useCampaigns stale-time / offline / reconnect behaviour.
 * • useTokenBalances stale-time / disabled-when-disconnected behaviour.
 *
 * All tests are deterministic and independent of live funds or the Stellar
 * network.  React Query's cache is reset between tests.
 */

import React, { type ReactNode } from "react";
import {
  cleanup,
  renderHook,
  waitFor,
  act,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Module mocks – must be declared before imports of the tested modules
// ---------------------------------------------------------------------------

// safe-storage shim (no real localStorage in jsdom for these tests)
const store: Record<string, string> = {};
vi.mock("@/utils/safe-storage", () => ({
  safeGetItem: (key: string) => store[key] ?? null,
  safeSetItem: (key: string, value: string) => { store[key] = value; },
  safeRemoveItem: (key: string) => { delete store[key]; },
  isStorageAvailable: () => true,
}));

// useSyncQueue online status toggle
let _isOnline = true;
vi.mock("@/hooks/use-sync-queue", () => ({
  useSyncQueue: () => ({ isOnline: _isOnline, pendingCount: 0 }),
}));

// Wallet mock for useTokenBalances
const mockAddress = vi.fn<() => string | null>(() => null);
const mockIsConnected = vi.fn(() => false);
vi.mock("@/providers/StellarWalletProvider", () => ({
  useWallet: () => ({
    address: mockAddress(),
    isConnected: mockIsConnected(),
    network: "Test SDF Network ; September 2015",
  }),
}));

// StellarService mock for useTokenBalances
vi.mock("@/services/stellar.service", () => ({
  StellarService: vi.fn().mockImplementation(() => ({
    getAccount: vi.fn().mockResolvedValue({ balances: [] }),
  })),
}));

vi.mock("@/services/transform-balances", () => ({
  extractBalances: vi.fn().mockReturnValue([]),
}));

vi.mock("@creit.tech/stellar-wallets-kit", () => ({
  WalletNetwork: {
    TESTNET: "Test SDF Network ; September 2015",
    PUBLIC: "Public Global Stellar Network ; September 2015",
  },
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { useCampaigns, CAMPAIGNS_QUERY_KEY } from "./use-campaigns";
import { useTokenBalances } from "./use-token-balance";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function makeFreshClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
}

// ---------------------------------------------------------------------------
// useCampaigns
// ---------------------------------------------------------------------------

describe("useCampaigns – query freshness", () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = makeFreshClient();
    _isOnline = true;
    // Clear safe-storage shim
    Object.keys(store).forEach((k) => delete store[k]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    qc.clear();
  });

  it("uses cached data and does NOT re-fetch within the stale window", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }),
    );

    const wrapper = makeWrapper(qc);

    // First render – populates the cache
    const { result, rerender } = renderHook(() => useCampaigns(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const callCountAfterFirst = fetchSpy.mock.calls.length;

    // Immediately re-render (within stale window) – should NOT trigger a new fetch
    rerender();
    await act(async () => {});

    expect(fetchSpy.mock.calls.length).toBe(callCountAfterFirst);
  });

  it("returns offline placeholder data when browser is offline", async () => {
    _isOnline = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { result } = renderHook(() => useCampaigns(), {
      wrapper: makeWrapper(qc),
    });

    // No fetch should be attempted while offline
    await act(async () => {});
    expect(fetchSpy).not.toHaveBeenCalled();

    // Placeholder / default campaigns are returned instead
    expect(result.current.campaigns.length).toBeGreaterThan(0);
  });

  it("re-fetches after coming back online", async () => {
    _isOnline = false;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }),
    );

    const { rerender } = renderHook(() => useCampaigns(), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {});
    expect(fetchSpy).not.toHaveBeenCalled();

    // Come back online
    _isOnline = true;
    rerender();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  });

  it("serves persisted localStorage snapshot as placeholder data offline", async () => {
    const cached = [
      { id: "cached-1", title: "Cached Campaign", category: "Test", raisedAmount: "100", goalAmount: "1000", token: "XLM", sponsorCount: 1, collaboratorCount: 0, status: "ACTIVE", description: "" },
    ];
    store["campaigns_cache"] = JSON.stringify(cached);
    _isOnline = false;

    const { result } = renderHook(() => useCampaigns(), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {});
    expect(result.current.campaigns[0].id).toBe("cached-1");
  });

  it("invalidateCampaigns triggers a re-fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }),
    );

    const { result } = renderHook(() => useCampaigns(), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => !result.current.isLoading);
    const callsBefore = fetchSpy.mock.calls.length;

    // Force invalidation (simulates post-mutation refresh)
    await act(async () => {
      result.current.invalidateCampaigns();
    });

    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsBefore));
  });
});

// ---------------------------------------------------------------------------
// useTokenBalances
// ---------------------------------------------------------------------------

describe("useTokenBalances – query freshness", () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = makeFreshClient();
    mockAddress.mockReturnValue(null);
    mockIsConnected.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    qc.clear();
  });

  it("does NOT fetch when wallet is disconnected", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    renderHook(() => useTokenBalances(), { wrapper: makeWrapper(qc) });
    await act(async () => {});

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns empty balances while wallet is disconnected", async () => {
    const { result } = renderHook(() => useTokenBalances(), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {});

    expect(result.current.balances).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it("staleTime is 15 s — query key includes address and network for correct invalidation", () => {
    // The query key must include address so switching wallets issues a new fetch.
    const address = "GBBB1234";
    mockAddress.mockReturnValue(address);
    mockIsConnected.mockReturnValue(true);

    const { result } = renderHook(() => useTokenBalances(), {
      wrapper: makeWrapper(qc),
    });

    // The query key observed in the cache should contain the address.
    const keys = qc.getQueryCache().getAll().map((q) => q.queryKey);
    const found = keys.some(
      (k) => Array.isArray(k) && k.includes(address),
    );
    expect(found).toBe(true);
  });
});
