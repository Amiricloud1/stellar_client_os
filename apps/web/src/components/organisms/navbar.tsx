"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { ConnectButton } from "./connect-button";
import { NetworkSwitcher } from "./network-switcher";

const NAV_LINKS = [
  { href: "/", label: "Home", current: true },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/balances", label: "Balances" },
  { href: "/social", label: "Social" },
  { href: "/grants", label: "Grants" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#faqs", label: "FAQs" },
  { href: "#contact", label: "Contact" },
];

export function Navbar() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mobileMenuOpen]);

  return (
    <nav
      aria-label="Main navigation"
      data-testid="main-navbar"
      className="fixed top-0 left-0 right-0 z-40 w-full max-w-full overflow-x-clip bg-black/50 backdrop-blur-md border-b border-white/10"
    >
      <div className="max-w-7xl mx-auto w-full px-3 sm:px-6 h-16 sm:h-20 flex items-center justify-between gap-2">
        {/* Mobile Brand + Menu Toggle */}
        <div className="flex md:hidden items-center gap-2 min-w-0">
          <button
            type="button"
            data-testid="mobile-nav-toggle"
            aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-navigation-menu"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            className="inline-flex items-center justify-center size-10 rounded-xl bg-white/5 border border-white/10 text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            {mobileMenuOpen ? (
              <X className="w-5 h-5" aria-hidden="true" />
            ) : (
              <Menu className="w-5 h-5" aria-hidden="true" />
            )}
          </button>
          <Link
            href="/"
            className="text-sm font-bold tracking-widest text-white truncate"
          >
            Fundable
          </Link>
        </div>

        {/* Desktop Nav */}
        <div className="hidden md:flex items-center gap-6 lg:gap-8 text-xs font-bold tracking-widest text-[#92A5A8]">
          <Link href="/" className="flex items-center gap-2 group text-white">
            Fundable
          </Link>

          {NAV_LINKS.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              aria-current={link.current ? "page" : undefined}
              className={
                link.current
                  ? "text-white transition-colors uppercase border-b-2 border-white pb-1"
                  : "hover:text-white transition-colors uppercase pb-1 border-b-2 border-transparent hover:border-white/50"
              }
            >
              {link.label}
            </Link>
          ))}
        </div>

        {/* Action Area */}
        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          <NetworkSwitcher />
          <ConnectButton />
        </div>
      </div>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div
          id="mobile-navigation-menu"
          data-testid="mobile-navigation-menu"
          className="md:hidden w-full max-w-full border-t border-white/10 bg-[#0F1621]/95 backdrop-blur-xl px-4 py-3"
        >
          <ul className="flex flex-col gap-1" aria-label="Mobile navigation links">
            {NAV_LINKS.map((link) => (
              <li key={link.label}>
                <Link
                  href={link.href}
                  aria-current={link.current ? "page" : undefined}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`block w-full rounded-lg px-3 py-2.5 text-xs font-bold uppercase tracking-widest transition-colors ${
                    link.current
                      ? "bg-white/10 text-white"
                      : "text-[#92A5A8] hover:bg-white/5 hover:text-white"
                  }`}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}
