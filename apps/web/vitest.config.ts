import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['e2e/**', 'node_modules/**'],
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'src/__tests__/contract/**/*.{test,spec}.{ts,tsx}',
      'src/__tests__/versioning/**/*.{test,spec}.{ts,tsx}',
      'src/__tests__/lifecycle/**/*.{test,spec}.{ts,tsx}',
    ],
    environmentMatchGlobs: [
      // Lifecycle tests exercise Node-only route handlers (Request/Response,
      // crypto, fs-backed storage stubs), so run them under the node env.
      ['src/__tests__/lifecycle/**', 'node'],
      // Contract and versioning suites import route handlers and OpenAPI
      // documents directly; keep them in node to avoid jsdom globals leaking.
      ['src/__tests__/contract/**', 'node'],
      ['src/__tests__/versioning/**', 'node'],
    ],
    // Deterministic, offline-only execution: no live network or funds.
    testTimeout: 15000,
    hookTimeout: 15000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});