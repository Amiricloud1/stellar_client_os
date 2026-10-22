"use client";

/**
 * ClientOnly
 *
 * Defers rendering of wallet-dependent or other browser-only subtrees until
 * after React hydration.  During SSR (and the first client render before the
 * hydration effect fires) the fallback is rendered instead, so the server
 * and the initial client snapshots always match – eliminating the
 * "Text content does not match server-rendered HTML" hydration warning.
 *
 * Usage:
 *   <ClientOnly fallback={<Skeleton />}>
 *     <WalletDependentContent />
 *   </ClientOnly>
 */

import { useEffect, useState, type ReactNode } from "react";

interface ClientOnlyProps {
  /** Content that must only run in the browser. */
  children: ReactNode;
  /**
   * Placeholder shown during SSR and before hydration.
   * Defaults to null (renders nothing until mounted).
   */
  fallback?: ReactNode;
}

export function ClientOnly({ children, fallback = null }: ClientOnlyProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
