"use client";

import React from "react";
import { useWallet } from "@/providers/StellarWalletProvider";
import { WalletNetwork } from "@creit.tech/stellar-wallets-kit";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Loader2, RefreshCw, AlertTriangle } from "lucide-react";
import {
  classifyWalletError,
  type WalletRecoveryAction,
} from "@/lib/wallet-errors";

export function NetworkSwitcher() {
  const { network, setNetwork, connectionStatus, error, clearError } =
    useWallet();
  const [isOpen, setIsOpen] = React.useState(false);

  const isLocked = connectionStatus === "connecting";

  // Map the last wallet failure to a safe recovery action. Network-switch
  // failures surface a "switch network" affordance; reconnect failures surface
  // a "reconnect" affordance. Form/network selection state is preserved.
  const recovery = React.useMemo(() => {
    if (!error) return null;
    return classifyWalletError(error);
  }, [error]);

  const handleRecovery = React.useCallback(() => {
    if (!recovery) return;
    const action: WalletRecoveryAction = recovery.action;
    if (action === "switch-network" && recovery.targetNetwork) {
      setNetwork(recovery.targetNetwork);
    } else if (action === "reconnect") {
      // Re-trigger the connection flow without discarding the current network.
      setNetwork(network);
    }
    clearError?.();
  }, [recovery, setNetwork, network, clearError]);

  const networks = [
    { id: WalletNetwork.TESTNET, name: "Testnet", color: "bg-yellow-500" },
    { id: WalletNetwork.PUBLIC, name: "Mainnet", color: "bg-green-500" },
  ];

  const currentNetwork = networks.find((n) => n.id === network) || networks[0];

  return (
    <div className="relative">
      <button
        onClick={() => !isLocked && setIsOpen(!isOpen)}
        disabled={isLocked}
        aria-disabled={isLocked}
        title={isLocked ? "Cannot switch network while connecting" : undefined}
        className={`flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 border border-white/10 transition-all group ${
          isLocked
            ? "opacity-50 cursor-not-allowed"
            : "hover:bg-white/10"
        }`}
      >
        {isLocked ? (
          <Loader2 className="w-3 h-3 text-white/40 animate-spin" />
        ) : (
          <div
            className={`w-2 h-2 rounded-full ${currentNetwork.color} shadow-[0_0_8px_currentColor]`}
          />
        )}
        <span className="text-white/70 text-xs font-bold uppercase tracking-wider">
          {currentNetwork.name}
        </span>
        {!isLocked && (
          <ChevronDown
            className={`w-3 h-3 text-white/40 transition-transform ${isOpen ? "rotate-180" : ""}`}
          />
        )}
      </button>

      <AnimatePresence>
        {recovery && (
          <motion.div
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            role="alert"
            className="absolute top-full right-0 mt-2 w-56 bg-[#0F1621] border border-amber-500/30 rounded-xl shadow-2xl overflow-hidden z-50 p-2"
          >
            <div className="flex items-start gap-2 px-1 py-1">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-white/70 text-[11px] leading-snug">
                {recovery.message}
              </p>
            </div>
            <button
              onClick={handleRecovery}
              className="mt-1 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 text-[11px] font-bold uppercase tracking-wider transition-all"
            >
              <RefreshCw className="w-3 h-3" />
              {recovery.action === "switch-network"
                ? "Switch network"
                : "Reconnect"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isOpen && !isLocked && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setIsOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 5, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              className="absolute top-full right-0 mt-2 w-32 bg-[#0F1621] border border-white/10 rounded-xl shadow-2xl overflow-hidden z-50 p-1"
            >
              {networks.map((n) => (
                <button
                  key={n.id}
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
                  <div className={`w-1.5 h-1.5 rounded-full ${n.color}`} />
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
