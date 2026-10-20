import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * E2E coverage for the critical fundraising journeys (#72).
 *
 * These tests are deterministic and independent of live funds:
 *  - All network calls to the API are intercepted with fixtures.
 *  - Wallet connection is mocked via `window.ethereum` injection.
 *  - No real transactions are signed or broadcast.
 *
 * Covered journeys:
 *  1. Campaign discovery and filtering (success + empty results boundary).
 *  2. Mocked wallet connect (success + rejected connect failure).
 *  3. Contribution preparation (success + failed contribution).
 *  4. Verification state rendering.
 *  5. Receipt display.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CAMPAIGNS = [
  {
    id: 'camp-1',
    title: 'Clean Water for Kano',
    summary: 'Bringing safe drinking water to rural communities.',
    category: 'water',
    status: 'active',
    goalAmount: '50000',
    raisedAmount: '12500',
    currency: 'USD',
    verification: 'verified',
    createdAt: '2024-01-10T00:00:00.000Z',
  },
  {
    id: 'camp-2',
    title: 'Solar Schools Initiative',
    summary: 'Powering classrooms with clean solar energy.',
    category: 'energy',
    status: 'active',
    goalAmount: '80000',
    raisedAmount: '40000',
    currency: 'USD',
    verification: 'pending',
    createdAt: '2024-02-01T00:00:00.000Z',
  },
  {
    id: 'camp-3',
    title: 'Community Health Clinic',
    summary: 'Building a clinic for 5,000 residents.',
    category: 'health',
    status: 'active',
    goalAmount: '120000',
    raisedAmount: '120000',
    currency: 'USD',
    verification: 'verified',
    createdAt: '2024-03-01T00:00:00.000Z',
  },
];

const MOCK_WALLET_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

const RECEIPT = {
  id: 'receipt-1',
  campaignId: 'camp-1',
  amount: '100',
  currency: 'USD',
  txHash: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  contributor: MOCK_WALLET_ADDRESS,
  status: 'confirmed',
  createdAt: '2024-04-01T12:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockWalletOptions = {
  /** When true, `eth_requestAccounts` rejects as if the user declined. */
  rejectConnect?: boolean;
  /** When true, `eth_sendTransaction` rejects as if the tx failed. */
  failTransaction?: boolean;
};

/**
 * Injects a deterministic `window.ethereum` mock before any page script runs.
 * The mock supports the minimal EIP-1193 surface the app relies on.
 */
async function installMockWallet(page: Page, options: MockWalletOptions = {}) {
  await page.addInitScript(
    ({ address, rejectConnect, failTransaction }) => {
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

      const ethereum = {
        isMetaMask: true,
        selectedAddress: null as string | null,
        chainId: '0x1',
        on(event: string, handler: (...args: unknown[]) => void) {
          (listeners[event] ??= []).push(handler);
        },
        removeListener(event: string, handler: (...args: unknown[]) => void) {
          listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler);
        },
        async request({ method }: { method: string; params?: unknown[] }) {
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              if (rejectConnect) {
                const err = new Error('User rejected the request.');
                (err as Error & { code?: number }).code = 4001;
                throw err;
              }
              ethereum.selectedAddress = address;
              return [address];
            case 'eth_chainId':
              return '0x1';
            case 'eth_sendTransaction':
              if (failTransaction) {
                const err = new Error('Transaction failed.');
                (err as Error & { code?: number }).code = -32603;
                throw err;
              }
              return '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
            default:
              return null;
          }
        },
      };

      (window as unknown as { ethereum: typeof ethereum }).ethereum = ethereum;
    },
    {
      address: MOCK_WALLET_ADDRESS,
      rejectConnect: options.rejectConnect ?? false,
      failTransaction: options.failTransaction ?? false,
    },
  );
}

/**
 * Intercepts campaign listing requests and serves deterministic fixtures.
 * Supports a `category` query filter to exercise filtering behavior.
 */
async function mockCampaignApi(page: Page) {
  await page.route('**/api/campaigns**', async (route: Route) => {
    const url = new URL(route.request().url());
    const category = url.searchParams.get('category');
    const filtered = category
      ? CAMPAIGNS.filter((c) => c.category === category)
      : CAMPAIGNS;

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: filtered, total: filtered.length }),
    });
  });
}

/**
 * Intercepts contribution submission and returns a deterministic receipt.
 */
async function mockContributionApi(page: Page, options: { fail?: boolean } = {}) {
  await page.route('**/api/contributions', async (route: Route) => {
    if (options.fail) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Contribution could not be processed.' }),
      });
      return;
    }

    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: RECEIPT }),
    });
  });
}

// ---------------------------------------------------------------------------
// Journey 1: Campaign discovery and filtering
// ---------------------------------------------------------------------------

test.describe('Campaign discovery', () => {
  test('lists active campaigns from the API', async ({ page }) => {
    await mockCampaignApi(page);
    await page.goto('/campaigns');

    await expect(page.getByRole('heading', { name: 'Clean Water for Kano' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Solar Schools Initiative' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Community Health Clinic' })).toBeVisible();
  });

  test('filters campaigns by category', async ({ page }) => {
    await mockCampaignApi(page);
    await page.goto('/campaigns');

    await page.getByRole('combobox', { name: /category/i }).selectOption('energy');

    await expect(page.getByRole('heading', { name: 'Solar Schools Initiative' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Clean Water for Kano' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Community Health Clinic' })).toHaveCount(0);
  });

  test('shows an empty state when no campaigns match', async ({ page }) => {
    await mockCampaignApi(page);
    await page.goto('/campaigns');

    // No fixture uses this category, so the API returns an empty list.
    await page.getByRole('combobox', { name: /category/i }).selectOption('education');

    await expect(page.getByText(/no campaigns found/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Clean Water for Kano' })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Journey 2: Mocked wallet connect
// ---------------------------------------------------------------------------

test.describe('Wallet connection', () => {
  test('connects a mocked wallet and shows the address', async ({ page }) => {
    await installMockWallet(page);
    await mockCampaignApi(page);
    await page.goto('/campaigns/camp-1');

    await page.getByRole('button', { name: /connect wallet/i }).click();

    await expect(page.getByText(/0x1234…5678/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /connect wallet/i })).toHaveCount(0);
  });

  test('surfaces an error when the user rejects the connection', async ({ page }) => {
    await installMockWallet(page, { rejectConnect: true });
    await mockCampaignApi(page);
    await page.goto('/campaigns/camp-1');

    await page.getByRole('button', { name: /connect wallet/i }).click();

    await expect(page.getByRole('alert')).toContainText(/rejected/i);
    await expect(page.getByRole('button', { name: /connect wallet/i })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Journey 3: Contribution preparation
// ---------------------------------------------------------------------------

test.describe('Contribution preparation', () => {
  test('prepares a contribution with the entered amount', async ({ page }) => {
    await installMockWallet(page);
    await mockCampaignApi(page);
    await page.goto('/campaigns/camp-1');

    await page.getByRole('button', { name: /connect wallet/i }).click();
    await expect(page.getByText(/0x1234…5678/i)).toBeVisible();

    await page.getByLabel(/amount/i).fill('100');
    await page.getByRole('button', { name: /contribute/i }).click();

    // Preparation step should show a review/summary before submission.
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('100');
    await expect(page.getByRole('dialog')).toContainText('Clean Water for Kano');
  });

  test('validates that an amount is required before preparing', async ({ page }) => {
    await installMockWallet(page);
    await mockCampaignApi(page);
    await page.goto('/campaigns/camp-1');

    await page.getByRole('button', { name: /connect wallet/i }).click();
    await expect(page.getByText(/0x1234…5678/i)).toBeVisible();

    await page.getByRole('button', { name: /contribute/i }).click();

    await expect(page.getByText(/enter an amount/i)).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Journey 4: Verification state rendering
// ---------------------------------------------------------------------------

test.describe('Verification state', () => {
  test('renders a verified badge for verified campaigns', async ({ page }) => {
    await mockCampaignApi(page);
    await page.goto('/campaigns/camp-1');

    await expect(page.getByText(/verified/i).first()).toBeVisible();
  });

  test('renders a pending badge for unverified campaigns', async ({ page }) => {
    await mockCampaignApi(page);
    await page.goto('/campaigns/camp-2');

    await expect(page.getByText(/pending/i).first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Journey 5: Receipt display
// ---------------------------------------------------------------------------

test.describe('Receipt display', () => {
  test('shows a receipt after a successful contribution', async ({ page }) => {
    await installMockWallet(page);
    await mockCampaignApi(page);
    await mockContributionApi(page);
    await page.goto('/campaigns/camp-1');

    await page.getByRole('button', { name: /connect wallet/i }).click();
    await expect(page.getByText(/0x1234…5678/i)).toBeVisible();

    await page.getByLabel(/amount/i).fill('100');
    await page.getByRole('button', { name: /contribute/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /confirm/i }).click();

    await expect(page.getByRole('heading', { name: /receipt/i })).toBeVisible();
    await expect(page.getByText(RECEIPT.txHash)).toBeVisible();
    await expect(page.getByText(/confirmed/i)).toBeVisible();
  });

  test('shows an error when the contribution fails', async ({ page }) => {
    await installMockWallet(page);
    await mockCampaignApi(page);
    await mockContributionApi(page, { fail: true });
    await page.goto('/campaigns/camp-1');

    await page.getByRole('button', { name: /connect wallet/i }).click();
    await expect(page.getByText(/0x1234…5678/i)).toBeVisible();

    await page.getByLabel(/amount/i).fill('100');
    await page.getByRole('button', { name: /contribute/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /confirm/i }).click();

    await expect(page.getByRole('alert')).toContainText(/could not be processed/i);
    await expect(page.getByRole('heading', { name: /receipt/i })).toHaveCount(0);
  });

  test('shows an error when the wallet transaction fails', async ({ page }) => {
    await installMockWallet(page, { failTransaction: true });
    await mockCampaignApi(page);
    await mockContributionApi(page);
    await page.goto('/campaigns/camp-1');

    await page.getByRole('button', { name: /connect wallet/i }).click();
    await expect(page.getByText(/0x1234…5678/i)).toBeVisible();

    await page.getByLabel(/amount/i).fill('100');
    await page.getByRole('button', { name: /contribute/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /confirm/i }).click();

    await expect(page.getByRole('alert')).toContainText(/transaction failed/i);
    await expect(page.getByRole('heading', { name: /receipt/i })).toHaveCount(0);
  });
});