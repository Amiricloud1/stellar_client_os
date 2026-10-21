import { test, expect } from '@playwright/test';

const MOBILE_VIEWPORTS = [
  { name: 'small-mobile-320', width: 320, height: 568 },
  { name: 'standard-mobile-375', width: 375, height: 667 },
];

test.describe('Responsive Mobile Workflows (#84)', () => {
  for (const vp of MOBILE_VIEWPORTS) {
    test(`navigation and wallet modal have no horizontal overflow at ${vp.width}x${vp.height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      const hasHorizontalOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      expect(hasHorizontalOverflow).toBe(false);

      // Mobile navigation toggle should be accessible
      const mobileToggle = page.getByTestId('mobile-nav-toggle');
      if (await mobileToggle.isVisible()) {
        await mobileToggle.click();
        await expect(page.getByTestId('mobile-navigation-menu')).toBeVisible();
        await mobileToggle.click();
      }

      // Connect Wallet button opens WalletModal without overflowing viewport
      const connectBtn = page.getByRole('button', { name: /connect your stellar wallet/i }).first();
      if (await connectBtn.isVisible()) {
        await connectBtn.click();
        const modal = page.getByTestId('wallet-modal-dialog');
        await expect(modal).toBeVisible();

        const modalBox = await modal.boundingBox();
        expect(modalBox).not.toBeNull();
        if (modalBox) {
          expect(modalBox.x).toBeGreaterThanOrEqual(0);
          expect(modalBox.x + modalBox.width).toBeLessThanOrEqual(vp.width + 1);
        }
      }
    });
  }
});
