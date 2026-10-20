"use client";

import { Lock, Loader2, RefreshCw, Wifi, PlugZap, XCircle } from "lucide-react";
import { useWallet } from "@/providers/StellarWalletProvider";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  classifyWalletError,
  type WalletErrorAction,
} from "@/lib/walletErrorRecovery";

/**
 * WalletStatus — visual badge for the current extension-wallet connection state.
 *
 * Fix for #393: when the extension wallet is locked it used to fall through to
 * the generic disconnected UI. Lines 15–35 detect the locked connection status
 * (set by StellarWalletProvider after a locked-wallet error code) and render a
 * dedicated Locked badge instead.
 */
const ACTION_PRESENTATION: Record<
  WalletErrorAction,
  {
    label: string;
    ariaLabel: string;
    Icon: typeof RefreshCw;
    className: string;
  }
> = {
  retry: {
    label: "Retry",
    ariaLabel: "Transaction failed. Retry the request.",
    Icon: RefreshCw,
    className: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  },
  switch_network: {
    label: "Switch network",
    ariaLabel: "Wrong network. Switch to the supported network.",
    Icon: Wifi,
    className: "border-sky-500/40 bg-sky-500/10 text-sky-400",
  },
  reconnect: {
    label: "Reconnect",
    ariaLabel: "Wallet connection lost. Reconnect your wallet.",
    Icon: PlugZap,
    className: "border-violet-500/40 bg-violet-500/10 text-violet-400",
  },
  abort: {
    label: "Dismiss",
    ariaLabel: "Request cannot be completed. Dismiss this message.",
    Icon: XCircle,
    className: "border-red-500/40 bg-red-500/10 text-red-400",
  },
};

export function WalletStatus({ className }: { className?: string }) {
  const {
    isConnected,
    isConnecting,
    isLocked,
    address,
    openModal,
    error,
    clearError,
  } = useWallet();

  // Locked wallet — show Locked badge instead of generic disconnected state.
  // Triggered when connect() catches WALLET_LOCKED_ERROR_CODE (-3) / unlock msgs.
  if (isLocked) {
    return (
      <button
        type="button"
        onClick={openModal}
        aria-label="Wallet is locked. Unlock your extension wallet and try again."
        className={cn("inline-flex", className)}
      >
        <Badge
          variant="outline"
          role="status"
          className="gap-1.5 border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 cursor-pointer px-3 py-1"
        >
          <Lock className="h-3 w-3" aria-hidden="true" />
          Locked
        </Badge>
      </button>
    );
  }

  // Unified error recovery — map the raw wallet/RPC/simulation/contract error
  // to a safe action (retry / switch network / reconnect / abort) and surface
  // it as an actionable badge. Form values are preserved by the caller; this
  // component only renders the recovery affordance.
  if (error) {
    const recovery = classifyWalletError(error);
    const { label, ariaLabel, Icon, className: actionClassName } =
      ACTION_PRESENTATION[recovery.action];

    const handleAction = () => {
      switch (recovery.action) {
        case "retry":
          recovery.retry?.();
          break;
        case "switch_network":
          recovery.switchNetwork?.();
          break;
        case "reconnect":
          openModal();
          break;
        case "abort":
          clearError?.();
          break;
      }
    };

    return (
      <button
        type="button"
        onClick={handleAction}
        aria-label={ariaLabel}
        data-action={recovery.action}
        className={cn("inline-flex", className)}
      >
        <Badge
          variant="outline"
          role="status"
          className={cn(
            "gap-1.5 hover:brightness-110 cursor-pointer px-3 py-1",
            actionClassName,
          )}
        >
          <Icon className="h-3 w-3" aria-hidden="true" />
          {label}
        </Badge>
      </button>
    );
  }

  if (isConnecting) {
    return (
      <div
        role="status"
        aria-label="Connecting wallet…"
        className={cn(
          "flex items-center gap-2 text-sm text-white/60",
          className,
        )}
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
        className={cn("inline-flex", className)}
      >
        <Badge
          variant="outline"
          className="gap-1.5 border-green-500/40 bg-green-500/10 text-green-400 px-3 py-1"
        >
          <span
            className="inline-block h-2 w-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]"
            aria-hidden="true"
          />
          Connected
        </Badge>
      </div>
    );
  }

  // Idle / disconnecting — no badge; ConnectButton handles the CTA.
  return null;
}

export default WalletStatus;
