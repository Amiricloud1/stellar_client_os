import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['e2e/**', 'node_modules/**'],
    // Presign, compilation, and cache tests must be deterministic and
    // independent of live funds/network. Run each file in isolation and
    // fail fast on unhandled errors so CI surfaces regressions clearly.
    isolate: true,
    fileParallelism: true,
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    testTimeout: 15000,
    hookTimeout: 15000,
    // Ensure the new API test suites are always discovered by CI.
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'src/**/__tests__/**/*.{test,spec}.{ts,tsx}',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});