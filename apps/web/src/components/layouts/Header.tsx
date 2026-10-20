'use client';

import React, { useEffect, useState } from 'react';
import { Bell, Contrast, Menu, X, Loader2 } from 'lucide-react';
import { useWallet } from '@/providers/StellarWalletProvider';

const HIGH_CONTRAST_STORAGE_KEY = 'fundable-high-contrast';

function HighContrastToggle() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(HIGH_CONTRAST_STORAGE_KEY) === 'true';
    setEnabled(stored);
  }, []);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(HIGH_CONTRAST_STORAGE_KEY, String(next));
      document.documentElement.classList.toggle('high-contrast', next);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={enabled}
      aria-label="Toggle high contrast mode"
      className="inline-grid size-10 shrink-0 place-content-center rounded-full bg-fundable-mid-dark hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-fundable-purple-2"
    >
      <Contrast aria-hidden="true" className="size-4" />
    </button>
  );
}

export interface HeaderProps {
  title: string;
  isMenuOpen?: boolean;
  onMenuToggle?: () => void;
  onNotificationsClick?: () => void;
}

function WalletStatus() {
  const { isConnected, isConnecting, address } = useWallet();

  if (isConnecting) {
    return (
      <div
        role="status"
        aria-label="Connecting wallet…"
        className="flex items-center gap-2 text-sm text-white/60"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <span>Connecting…</span>
      </div>
    );
  }

  if (isConnected && address) {
    return (
      <div
        role="status"
        aria-label={`Wallet connected: ${address.slice(0, 4)}…${address.slice(-4)}`}
        className="flex items-center gap-2 text-sm"
      >
        <span
          className="inline-block h-2 w-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]"
          aria-hidden="true"
        />
        <span className="text-green-400 font-medium">Connected</span>
      </div>
    );
  }

  return null;
}

export function Header({
  title,
  isMenuOpen = false,
  onMenuToggle,
  onNotificationsClick,
}: HeaderProps) {
  const MenuIcon = isMenuOpen ? X : Menu;

  return (
    <header className="flex w-full max-w-full items-center justify-between gap-2 overflow-x-hidden border-b border-b-fundable-mid-dark px-3 py-3 text-white md:px-5">
      <div className="flex min-w-0 items-center gap-x-2">
        {onMenuToggle && (
          <button
            type="button"
            onClick={onMenuToggle}
            aria-label={isMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={isMenuOpen}
            className="inline-grid size-10 shrink-0 place-content-center rounded-md hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-fundable-purple-2"
          >
            <MenuIcon aria-hidden="true" className="size-5" />
          </button>
        )}
        <h1 className="truncate font-bricolage text-xl font-medium capitalize md:text-2xl">
          {title}
        </h1>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        <WalletStatus />
        <HighContrastToggle />
        {onNotificationsClick && (
          <button
            type="button"
            onClick={onNotificationsClick}
            aria-label="View notifications"
            className="inline-grid size-10 sm:size-12 place-content-center rounded-full bg-fundable-mid-dark hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-fundable-purple-2"
          >
            <Bell aria-hidden="true" className="size-5" />
          </button>
        )}
      </div>
    </header>
  );
}

export default Header;
