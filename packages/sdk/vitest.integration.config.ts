import { defineConfig } from 'vitest/config';

/**
 * Vitest config for integration tests.
 *
 * These tests exercise the full SDK lifecycle: simulation, signing,
 * submission, confirmation, and event decoding.
 *
 * Two execution modes are supported:
 *
 *   1. Live local node (default when reachable):
 *      Requires a running local Soroban node (stellar-cli local network)
 *      and deployed contracts. Triggered explicitly via:
 *
 *        pnpm test:integration
 *
 *      Environment variables (can be set in packages/sdk/.env.integration):
 *        SOROBAN_RPC_URL             – defaults to http://localhost:8000/soroban/rpc
 *        SOROBAN_NETWORK_PASSPHRASE  – defaults to the standalone passphrase
 *        PAYMENT_STREAM_WASM_PATH    – path to compiled payment-stream .wasm
 *        DISTRIBUTOR_WASM_PATH       – path to compiled distributor .wasm
 *
 *   2. Mock harness (no live node required):
 *      When no local node is reachable (or SOROBAN_INTEGRATION_MODE=mock),
 *      the lifecycle tests fall back to an in-process mock RPC harness so
 *      CI can validate the suite deterministically without live funds or
 *      network access. Set SOROBAN_INTEGRATION_MODE=mock to force this mode.
 *
 * These tests are intentionally excluded from the standard `test` /
 * `test:watch` scripts and must be triggered explicitly.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Include both the original integration tests and the new lifecycle
    // integration tests. Lifecycle tests live under
    // src/__integration_tests__/lifecycle/.
    include: [
      'src/__integration_tests__/**/*.integration.test.ts',
      'src/__integration_tests__/**/*.lifecycle.test.ts',
    ],
    // Give each test file a generous timeout – local node startup + contract
    // deployment can take several seconds.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Run integration test files sequentially so they don't race over the
    // shared local node or mock harness state, and so ordering is
    // deterministic across CI runs.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    // Deterministic ordering: run files in a stable sequence rather than
    // relying on filesystem enumeration order.
    sequence: {
      shuffle: false,
    },
    // Never run in watch mode from this config.
    watch: false,
  },
});