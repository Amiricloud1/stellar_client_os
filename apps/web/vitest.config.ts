import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest configuration for the web app.
 *
 * Test layout:
 * - Unit / integration tests live alongside source under `src/**` and in `tests/**`.
 *   They run in a jsdom environment and must be deterministic: no live network,
 *   no live funds, no real wallets. Wallet/RPC interactions are mocked.
 * - End-to-end specs live under `e2e/**` and are driven by Playwright, not Vitest,
 *   so they are excluded here.
 *
 * Determinism guarantees:
 * - `environment: 'jsdom'` provides a browser-like DOM without a real network.
 * - `globals: true` exposes describe/it/expect without imports.
 * - `setupFiles` installs deterministic fixtures and network guards.
 * - `pool: 'forks'` isolates each test file so mocks and module state do not leak.
 * - `restoreMocks`/`clearMocks`/`mockReset` reset state between tests.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    // E2E specs are Playwright-driven; keep them out of the Vitest run.
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', 'coverage/**'],
    // Only run unit/integration tests from the app source and tests dirs.
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'tests/**/*.{test,spec}.{ts,tsx}',
    ],
    setupFiles: ['./tests/setup.ts'],
    // Isolate module state and mocks per file for deterministic runs.
    pool: 'forks',
    isolate: true,
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    // Fail fast on unexpected live network calls in tests.
    testTimeout: 10000,
    hookTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});