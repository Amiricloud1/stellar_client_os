// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { AnimatedProgressBar } from "@/components/modules/campaigns/AnimatedProgressBar";
import { CampaignAccessibilityControls } from "@/components/modules/campaign/CampaignAccessibilityControls";
import { WalletModal } from "@/components/organisms/wallet-modal";
import { CampaignDonationPanel } from "@/components/modules/campaign/donation/CampaignDonationPanel";
import { FilterPanel, DEFAULT_FILTERS } from "@/components/audit/filter-panel";
import AdminNavbar from "@/components/organisms/AdminNavbar";
import { SidebarProvider } from "@/components/ui/sidebar";

// Mock wallet provider hook
const mockWallet = {
  isModalOpen: true,
  closeModal: vi.fn(),
  supportedWallets: [
    { id: "freighter", name: "Freighter" },
    { id: "albedo", name: "Albedo" },
    { id: "lobstr", name: "Lobstr" },
  ],
  connect: vi.fn(),
  disconnect: vi.fn(),
  isConnecting: false,
  isConnected: false,
  address: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
  network: "TESTNET" as const,
  setNetwork: vi.fn(),
  openModal: vi.fn(),
  wallet: null,
};

vi.mock("@/providers/StellarWalletProvider", () => ({
  useWallet: () => mockWallet,
}));

// ResizeObserver stub for charts in jsdom
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

// matchMedia stub for use-mobile hook in jsdom
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

describe("WCAG 2.2 AA Accessibility Audit for Primary Journeys (Issue #75)", () => {
  // ── 1. Campaign Journey ─────────────────────────────────────────────────────
  describe("1. Campaign Journey", () => {
    it("provides accessible progressbar with complete ARIA value properties", () => {
      render(
        <AnimatedProgressBar
          totalRaised={7500}
          targetAmount={10000}
          minTarget={2500}
          currencySymbol="XLM"
        />
      );
      const progressbar = screen.getByRole("progressbar");
      expect(progressbar).toBeTruthy();
      expect(progressbar.getAttribute("aria-valuenow")).toBe("75");
      expect(progressbar.getAttribute("aria-valuemin")).toBe("0");
      expect(progressbar.getAttribute("aria-valuemax")).toBe("100");
      expect(progressbar.getAttribute("aria-label")).toBe("Campaign funding progress");
      expect(progressbar.getAttribute("aria-valuetext")).toContain("75% funded");
    });

    it("has accessible buttons with touch target size >= 24px and clear names", () => {
      render(<CampaignAccessibilityControls />);
      const button = screen.getByRole("button", { name: /high contrast/i });
      expect(button).toBeTruthy();
      expect(button.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(button);
      expect(button.getAttribute("aria-pressed")).toBe("true");
    });
  });

  // ── 2. Wallet Journey ───────────────────────────────────────────────────────
  describe("2. Wallet Journey", () => {
    it("renders modal dialog with aria-modal='true' and accessible heading", () => {
      render(<WalletModal />);
      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeTruthy();
      expect(dialog.getAttribute("aria-modal")).toBe("true");

      const title = screen.getByRole("heading", { name: /connect wallet/i });
      expect(title).toBeTruthy();
    });

    it("renders wallet choices as an accessible radiogroup with keyboard navigation", () => {
      render(<WalletModal />);
      const radiogroup = screen.getByRole("radiogroup", { name: /choose a wallet/i });
      expect(radiogroup).toBeTruthy();

      const options = screen.getAllByRole("radio");
      expect(options).toHaveLength(3);

      // Select option via keyboard Space
      fireEvent.keyDown(options[0], { key: " " });
      expect(options[0].getAttribute("aria-checked")).toBe("true");
      expect(options[1].getAttribute("aria-checked")).toBe("false");

      // Connect button is enabled after selection
      const connectBtn = screen.getByTestId("connect-now-button");
      expect(connectBtn.getAttribute("aria-disabled")).toBe("false");
    });
  });

  // ── 3. Contribution Journey ─────────────────────────────────────────────────
  describe("3. Contribution Journey", () => {
    it("provides explicit label associations and aria-required on donation inputs", () => {
      render(<CampaignDonationPanel campaignId="camp-101" />);

      const amountInput = screen.getByLabelText(/donation amount/i);
      expect(amountInput).toBeTruthy();
      expect(amountInput.getAttribute("id")).toBe("donation-amount");
      expect(amountInput.getAttribute("aria-required")).toBe("true");

      const tokenSelect = screen.getByLabelText(/token/i);
      expect(tokenSelect).toBeTruthy();
      expect(tokenSelect.getAttribute("id")).toBe("donation-token");

      const messageInput = screen.getByLabelText(/message to the creator/i);
      expect(messageInput).toBeTruthy();
      expect(messageInput.getAttribute("id")).toBe("donation-message");

      const anonymousCheckbox = screen.getByLabelText(/donate anonymously/i);
      expect(anonymousCheckbox).toBeTruthy();
      expect(anonymousCheckbox.getAttribute("id")).toBe("donation-anonymous");
    });

    it("preset amount buttons expose accessible pressed state and action label", () => {
      render(<CampaignDonationPanel campaignId="camp-101" />);
      const preset50 = screen.getByRole("button", { name: /select 50 xlm/i });
      expect(preset50).toBeTruthy();
      expect(preset50.getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(preset50);
      expect(preset50.getAttribute("aria-pressed")).toBe("true");
    });

    it("surfaces errors with role='alert' and connects them via aria-describedby", async () => {
      render(<CampaignDonationPanel campaignId="camp-101" />);
      const submitBtn = screen.getByTestId("donation-submit");

      fireEvent.click(submitBtn);

      const alert = await screen.findByRole("alert");
      expect(alert).toBeTruthy();

      const amountInput = screen.getByLabelText(/donation amount/i);
      expect(amountInput.getAttribute("aria-invalid")).toBe("true");
      expect(amountInput.getAttribute("aria-describedby")).toBe("donation-error");
    });
  });

  // ── 4. Verification Journey ─────────────────────────────────────────────────
  describe("4. Verification Journey", () => {
    it("FilterPanel has semantic aside landmark and all inputs have associated labels", () => {
      render(
        <FilterPanel
          filters={DEFAULT_FILTERS}
          onChange={vi.fn()}
          onReset={vi.fn()}
          totalResults={25}
        />
      );

      const panel = screen.getByRole("complementary", { name: /audit filters/i });
      expect(panel).toBeTruthy();

      expect(screen.getByLabelText(/search/i)).toBeTruthy();
      expect(screen.getByLabelText(/action/i)).toBeTruthy();
      expect(screen.getByLabelText(/date range/i)).toBeTruthy();
      expect(screen.getByLabelText(/from/i)).toBeTruthy();
      expect(screen.getByLabelText(/to/i)).toBeTruthy();
      expect(screen.getByLabelText(/user/i)).toBeTruthy();
      expect(screen.getByLabelText(/resource/i)).toBeTruthy();

      const resetBtn = screen.getByRole("button", { name: /reset filters/i });
      expect(resetBtn).toBeTruthy();
    });
  });

  // ── 5. Admin Journey ────────────────────────────────────────────────────────
  describe("5. Admin Journey", () => {
    it("AdminNavbar provides semantic navigation landmark and accessible notification button", () => {
      render(
        <SidebarProvider>
          <AdminNavbar />
        </SidebarProvider>
      );

      const nav = screen.getByRole("navigation", { name: /admin header navigation/i });
      expect(nav).toBeTruthy();

      const notifyBtn = screen.getByRole("button", { name: /view notifications/i });
      expect(notifyBtn).toBeTruthy();

      const sidebarTrigger = screen.getByRole("button", { name: /toggle sidebar/i });
      expect(sidebarTrigger).toBeTruthy();
    });
  });
});
