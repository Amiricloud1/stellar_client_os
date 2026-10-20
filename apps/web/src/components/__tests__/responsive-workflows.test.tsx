// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const MockWalletNetwork = {
  TESTNET: "Test SDF Network ; September 2015",
  PUBLIC: "Public Global Stellar Network ; September 2015",
} as const;

vi.mock("@creit.tech/stellar-wallets-kit", () => ({
  WalletNetwork: {
    TESTNET: "Test SDF Network ; September 2015",
    PUBLIC: "Public Global Stellar Network ; September 2015",
  },
}));

import { Navbar } from "@/components/organisms/navbar";
import { Header } from "@/components/layouts/Header";
import { AppSidebar } from "@/components/ui/app-sidebar";
import { WalletModal } from "@/components/organisms/wallet-modal";
import { CampaignDonationPanel } from "@/components/modules/campaign/donation/CampaignDonationPanel";
import { OneTimeDonationButton } from "@/components/modules/campaign/donation/OneTimeDonationButton";
import { SyncQueueBanner } from "@/components/organisms/SyncQueueBanner";
import { SyncQueueDrawer } from "@/components/organisms/SyncQueueDrawer";
import type { SyncQueueItem, SyncQueueState } from "@/hooks/use-sync-queue";

// ── Mocks ────────────────────────────────────────────────────────────────────

const walletState = {
  isConnected: false,
  isConnecting: false,
  isLocked: false,
  isModalOpen: false,
  address: null as string | null,
  network: MockWalletNetwork.TESTNET as string,
  connectionStatus: "disconnected" as "disconnected" | "connecting" | "connected",
  supportedWallets: [
    { id: "freighter", name: "Freighter", type: "extension", isAvailable: true },
    { id: "albedo", name: "Albedo", type: "web", isAvailable: true },
    { id: "xbull", name: "xBull", type: "extension", isAvailable: true },
  ],
  openModal: vi.fn(() => {
    walletState.isModalOpen = true;
  }),
  closeModal: vi.fn(() => {
    walletState.isModalOpen = false;
  }),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  setNetwork: vi.fn(),
};

vi.mock("@/providers/StellarWalletProvider", () => ({
  useWallet: () => walletState,
  WalletId: {},
}));

let currentPathname = "/campaigns";
vi.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
}));

const setOpenMobile = vi.fn();
vi.mock("@/components/ui/sidebar", () => ({
  Sidebar: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <aside {...props}>{children}</aside>
  ),
  useSidebar: () => ({
    setOpenMobile,
  }),
}));

vi.mock("react-hot-toast", () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    writable: true,
    configurable: true,
    value: height,
  });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const maxWidthMatch = /max-width:\s*(\d+)px/.exec(query);
      const matches = maxWidthMatch ? width <= Number(maxWidthMatch[1]) : width < 768;
      return {
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
  window.dispatchEvent(new Event("resize"));
}

function makeSyncQueue(overrides: Partial<SyncQueueState> = {}): SyncQueueState {
  const queue: SyncQueueItem[] = overrides.queue ?? [
    {
      id: "item-1",
      label: "mangrove_canopy_evidence_01.jpg",
      description: "Campaign verification photo",
      status: "pending",
      enqueuedAt: 1774008000000,
      retryCount: 0,
    },
    {
      id: "item-2",
      label: "gps_field_survey_report.pdf",
      description: "Field boundary geojson",
      status: "failed",
      error: "Request timed out on cellular connection",
      enqueuedAt: 1774008060000,
      retryCount: 2,
    },
  ];

  const pendingItems = queue.filter((i) => i.status === "pending");
  const syncingItems = queue.filter((i) => i.status === "syncing");
  const failedItems = queue.filter((i) => i.status === "failed");
  const syncedItems = queue.filter((i) => i.status === "synced");

  return {
    queue,
    pendingCount: pendingItems.length,
    isSyncing: false,
    isOnline: true,
    pendingItems,
    syncingItems,
    failedItems,
    syncedItems,
    enqueue: vi.fn(),
    remove: vi.fn(),
    retryItem: vi.fn(),
    retryAll: vi.fn().mockResolvedValue(undefined),
    clearSynced: vi.fn(),
    clearAll: vi.fn(),
    ...overrides,
  };
}

describe("Responsive wallet and campaign workflows (#84)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    setViewport(375, 667); // Mobile viewport (iPhone SE / standard 375px)
    walletState.isConnected = false;
    walletState.isConnecting = false;
    walletState.isLocked = false;
    walletState.isModalOpen = false;
    walletState.address = null;
    walletState.network = MockWalletNetwork.TESTNET;
    walletState.connectionStatus = "disconnected";
    currentPathname = "/campaigns";
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  describe("1. Mobile Navigation (Navbar, Header, AppSidebar, NetworkSwitcher, ConnectButton)", () => {
    it("renders accessible mobile menu toggle in Navbar on 320px/375px viewports and prevents horizontal overflow", () => {
      setViewport(320, 568);
      render(<Navbar />);

      const nav = screen.getByTestId("main-navbar");
      expect(nav.className).toContain("max-w-full");
      expect(nav.className).toContain("overflow-x-clip");

      const toggleBtn = screen.getByTestId("mobile-nav-toggle");
      expect(toggleBtn.getAttribute("aria-expanded")).toBe("false");
      expect(toggleBtn.getAttribute("aria-label")).toBe("Open navigation menu");
      expect(screen.queryByTestId("mobile-navigation-menu")).toBeNull();

      // Open mobile navigation menu
      fireEvent.click(toggleBtn);
      expect(toggleBtn.getAttribute("aria-expanded")).toBe("true");
      expect(toggleBtn.getAttribute("aria-label")).toBe("Close navigation menu");

      const mobileMenu = screen.getByTestId("mobile-navigation-menu");
      expect(mobileMenu).toBeTruthy();
      expect(mobileMenu.textContent).toContain("Campaigns");
      expect(mobileMenu.textContent).toContain("Balances");
      expect(mobileMenu.textContent).toContain("Grants");

      // Escape key closes mobile menu
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByTestId("mobile-navigation-menu")).toBeNull();
    });

    it("provides accessible network switcher menu and wallet trigger in Navbar on mobile", () => {
      render(<Navbar />);

      const netTrigger = screen.getByTestId("network-switcher-trigger");
      expect(netTrigger.getAttribute("aria-haspopup")).toBe("menu");
      expect(netTrigger.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(netTrigger);
      expect(netTrigger.getAttribute("aria-expanded")).toBe("true");
      const menuItems = screen.getAllByRole("menuitemradio");
      expect(menuItems).toHaveLength(2);

      fireEvent.click(menuItems[1]); // Mainnet
      expect(walletState.setNetwork).toHaveBeenCalledWith(MockWalletNetwork.PUBLIC);

      const connectBtn = screen.getByRole("button", { name: /connect your stellar wallet/i });
      fireEvent.click(connectBtn);
      expect(walletState.openModal).toHaveBeenCalledTimes(1);
    });

    it("renders AppSidebar bottom navigation on mobile viewports with aria-current and overflow protection", () => {
      setViewport(375, 667);
      render(<AppSidebar />);

      const mobileNav = screen.getByRole("navigation", { name: "Mobile navigation" });
      expect(mobileNav).toBeTruthy();
      expect(mobileNav.parentElement?.className).toContain("overflow-x-hidden");

      const campaignsLink = screen.getByRole("link", { name: /campaigns/i });
      expect(campaignsLink.getAttribute("aria-current")).toBe("page");

      fireEvent.click(campaignsLink);
      expect(setOpenMobile).toHaveBeenCalledWith(false);
    });

    it("renders Header with accessible mobile menu button and connecting/connected wallet statuses without overflow", () => {
      const onMenuToggle = vi.fn();
      walletState.isConnecting = true;

      const { rerender } = render(
        <Header title="Campaign Overview" isMenuOpen={false} onMenuToggle={onMenuToggle} />
      );

      expect(screen.getByRole("status", { name: "Connecting wallet…" })).toBeTruthy();
      const menuBtn = screen.getByRole("button", { name: "Open navigation menu" });
      fireEvent.click(menuBtn);
      expect(onMenuToggle).toHaveBeenCalledTimes(1);

      walletState.isConnecting = false;
      walletState.isConnected = true;
      walletState.address = "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMN";
      rerender(<Header title="Campaign Overview" isMenuOpen={true} onMenuToggle={onMenuToggle} />);

      expect(screen.getByRole("button", { name: "Close navigation menu" })).toBeTruthy();
      expect(screen.getByRole("status", { name: /wallet connected/i })).toBeTruthy();
    });
  });

  describe("2. Responsive Wallet Modal Workflow", () => {
    it("constrains WalletModal to mobile viewport width without mx-4 horizontal overflow and supports keyboard/click selection", async () => {
      setViewport(320, 568);
      walletState.isModalOpen = true;

      render(<WalletModal />);

      const dialog = screen.getByTestId("wallet-modal-dialog");
      expect(dialog.className).toContain("w-[calc(100vw-2rem)]");
      expect(dialog.className).toContain("max-h-[90dvh]");
      expect(dialog.className).not.toContain("mx-4");

      const connectNowBtn = screen.getByTestId("connect-now-button") as HTMLButtonElement;
      expect(connectNowBtn.disabled).toBe(true);

      // Select Freighter via keyboard
      const freighterOption = screen.getByTestId("wallet-option-freighter");
      fireEvent.keyDown(freighterOption, { key: "Enter" });
      expect(freighterOption.getAttribute("aria-checked")).toBe("true");
      expect(connectNowBtn.disabled).toBe(false);

      // Switch selection to Albedo via click
      const albedoOption = screen.getByTestId("wallet-option-albedo");
      fireEvent.click(albedoOption);
      expect(albedoOption.getAttribute("aria-checked")).toBe("true");

      fireEvent.click(connectNowBtn);
      await waitFor(() => {
        expect(walletState.connect).toHaveBeenCalledWith("albedo");
      });
    });
  });

  describe("3. Responsive Campaign Contribution Workflow", () => {
    it("prompts unconnected mobile user to connect wallet and opens WalletModal when submitting donation", () => {
      setViewport(375, 667);
      render(
        <CampaignDonationPanel campaignId="camp-amazon-1" campaignName="Amazon Canopy" />
      );

      const panel = screen.getByTestId("campaign-donation-panel");
      expect(panel.className).toContain("w-full");
      expect(panel.className).toContain("max-w-full");
      expect(panel.className).toContain("overflow-x-hidden");

      // Choose preset amount
      fireEvent.click(screen.getByTestId("donation-preset-25"));
      expect((screen.getByTestId("donation-amount") as HTMLInputElement).value).toBe("25");

      // Submit while wallet is disconnected
      fireEvent.click(screen.getByTestId("donation-submit"));
      expect(screen.getByTestId("donation-error").textContent).toContain(
        "Connect your wallet to donate."
      );
      expect(walletState.openModal).toHaveBeenCalledTimes(1);
    });

    it("completes mobile donation workflow and renders wrap-safe receipt inside OneTimeDonationButton modal", async () => {
      setViewport(320, 568);
      walletState.isConnected = true;
      walletState.address = "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMN";

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          receipt: {
            reference: "DON-20260320-LONG-REFERENCE-9988776655",
            amount: "50",
            token: "USDC",
            donorAddress: walletState.address,
            allocationLabel: "Creator project discretion (99%) + Insurance Pool (1%)",
            allocationDescription: "Funds are disbursed directly to verified milestones.",
          },
        }),
      } as Response);

      render(
        <OneTimeDonationButton
          campaignId="camp-amazon-1"
          campaignName="Amazon Canopy"
          defaultToken="USDC"
        />
      );

      fireEvent.click(screen.getByTestId("one-time-donate-trigger"));
      const modalDialog = screen.getByRole("dialog");
      expect(modalDialog.className).toContain("max-w-[calc(100vw-2rem)]");
      expect(modalDialog.className).toContain("overflow-x-hidden");

      fireEvent.click(screen.getByTestId("donation-preset-50"));
      fireEvent.click(screen.getByTestId("donation-submit"));

      await waitFor(() => {
        expect(screen.getByTestId("donation-receipt")).toBeTruthy();
      });

      const receipt = screen.getByTestId("donation-receipt");
      expect(receipt.className).toContain("overflow-x-hidden");
      expect(screen.getByTestId("donation-reference").className).toContain("break-all");
      expect(screen.getByTestId("donation-reference").textContent).toBe(
        "DON-20260320-LONG-REFERENCE-9988776655"
      );
    });
  });

  describe("4. Responsive Sync Queue Banner & Drawer Workflow", () => {
    it("renders SyncQueueBanner and opens mobile bottom-sheet SyncQueueDrawer with accessible item controls", async () => {
      setViewport(375, 667);
      const syncQueue = makeSyncQueue();
      const onOpenDrawer = vi.fn();

      render(<SyncQueueBanner syncQueue={syncQueue} onOpenDrawer={onOpenDrawer} />);

      const banner = screen.getByTestId("sync-queue-banner");
      expect(banner.className).toContain("max-w-full");
      expect(banner.className).toContain("overflow-x-hidden");

      // Click "View all" to open drawer
      const viewAllBtn = screen.getByRole("button", { name: "View pending sync items" });
      fireEvent.click(viewAllBtn);
      expect(onOpenDrawer).toHaveBeenCalledTimes(1);

      const onClose = vi.fn();
      render(<SyncQueueDrawer open={true} onClose={onClose} syncQueue={syncQueue} />);

      const drawer = screen.getByTestId("sync-queue-drawer");
      expect(drawer.className).toContain("w-full");
      expect(drawer.className).toContain("max-w-full");
      expect(drawer.className).toContain("overflow-x-hidden");

      // Per-item retry and remove controls have accessible labels and minimum touch target classes
      const retryItemBtn = screen.getByRole("button", {
        name: "Retry syncing gps_field_survey_report.pdf",
      });
      expect(retryItemBtn.className).toContain("min-h-9");
      expect(retryItemBtn.className).toContain("min-w-9");
      fireEvent.click(retryItemBtn);
      expect(syncQueue.retryItem).toHaveBeenCalledWith("item-2");

      const removeItemBtn = screen.getByRole("button", {
        name: "Remove mangrove_canopy_evidence_01.jpg from queue",
      });
      fireEvent.click(removeItemBtn);
      expect(syncQueue.remove).toHaveBeenCalledWith("item-1");

      // Retry all in footer
      const retryAllBtn = screen.getByRole("button", {
        name: "Retry all pending and failed uploads",
      });
      fireEvent.click(retryAllBtn);
      expect(syncQueue.retryAll).toHaveBeenCalledTimes(1);
    });
  });
});
