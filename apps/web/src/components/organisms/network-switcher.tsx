"use client";

import React from "react";
import { useWallet } from "@/providers/StellarWalletProvider";
import { WalletNetwork } from "@creit.tech/stellar-wallets-kit";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Loader2 } from "lucide-react";

export function NetworkSwitcher() {
  const { network, setNetwork, connectionStatus } = useWallet();
  const [isOpen, setIsOpen] = React.useState(false);

  const isLocked = connectionStatus === "connecting";

  const networks = [
    { id: WalletNetwork.TESTNET, name: "Testnet", color: "bg-yellow-500" },
    { id: WalletNetwork.PUBLIC, name: "Mainnet", color: "bg-green-500" },
  ];

  const currentNetwork = networks.find((n) => n.id === network) || networks[0];

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        data-testid="network-switcher-trigger"
        onClick={() => !isLocked && setIsOpen(!isOpen)}
        disabled={isLocked}
        aria-disabled={isLocked}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`Select Stellar network (current: ${currentNetwork.name})`}
        title={isLocked ? "Cannot switch network while connecting" : undefined}
        className={`flex items-center gap-1.5 sm:gap-2 px-2.5 py-2 sm:px-4 sm:py-2 rounded-xl bg-white/5 border border-white/10 transition-all group ${
          isLocked
            ? "opacity-50 cursor-not-allowed"
            : "hover:bg-white/10"
        }`}
      >
        {isLocked ? (
          <Loader2 className="w-3 h-3 text-white/40 animate-spin" aria-hidden="true" />
        ) : (
          <div
            aria-hidden="true"
            className={`w-2 h-2 rounded-full ${currentNetwork.color} shadow-[0_0_8px_currentColor]`}
          />
        )}
        <span className="text-white/70 text-[11px] sm:text-xs font-bold uppercase tracking-wider">
          {currentNetwork.name}
        </span>
        {!isLocked && (
          <ChevronDown
            aria-hidden="true"
            className={`w-3 h-3 text-white/40 transition-transform ${isOpen ? "rotate-180" : ""}`}
          />
        )}
      </button>

      <AnimatePresence>
        {isOpen && !isLocked && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setIsOpen(false)}
            />
            <motion.div
              role="menu"
              aria-label="Stellar networks"
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 5, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              className="absolute top-full right-0 mt-2 w-32 bg-[#0F1621] border border-white/10 rounded-xl shadow-2xl overflow-hidden z-50 p-1"
            >
              {networks.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={network === n.id}
                  onClick={() => {
                    setNetwork(n.id);
                    setIsOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
                    network === n.id
                      ? "bg-white/10 text-white"
                      : "text-white/50 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <div className={`w-1.5 h-1.5 rounded-full ${n.color}`} aria-hidden="true" />
                  {n.name}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
