import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'html',

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    storageState: undefined,
    // Disable live network calls: block any request that is not served by the
    // app under test or explicitly mocked in the specs.
    offline: false,
    serviceWorkers: 'block',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    // Start the app with a seeded, deterministic fixture environment so E2E
    // runs never depend on live funds or external services.
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NODE_ENV: 'test',
      E2E: '1',
      NEXT_PUBLIC_E2E: '1',
      NEXT_PUBLIC_E2E_FIXTURES: '1',
      NEXT_PUBLIC_DISABLE_LIVE_NETWORK: '1',
      NEXT_PUBLIC_CHAIN_NETWORK: 'testnet',
      NEXT_PUBLIC_WALLET_MOCK: '1',
      PORT: String(PORT),
    },
  },
});