/**
 * @deprecated Utility methods for Stellar address validation and amount formatting.
 * All smart contract operations now route through {@link @/services/stellar.service.ts}
 * or the SDK client wrappers in {@link @/lib/api.ts}.
 */
import { Keypair, Networks, Horizon } from '@stellar/stellar-sdk'
import { StreamRecord } from './validations'

// Use testnet for development
export const server = new Horizon.Server('https://horizon-testnet.stellar.org')
export const networkPassphrase = Networks.TESTNET

/**
 * Identity of the chain a wallet flow is bound to.
 *
 * Captured when a simulation/signing/confirmation flow starts and re-checked
 * before each subsequent step so that a network switch mid-flight aborts the
 * stale flow instead of submitting to the wrong chain (issue #70).
 */
export interface ChainIdentity {
  /** Stellar network passphrase (e.g. `Networks.TESTNET`). */
  networkPassphrase: string
  /** Chain id used by the SDK client wrappers; defaults to the passphrase. */
  chainId: string
}

/** Result of comparing a captured identity against the active network. */
export type ChainIdentityCheck =
  | { ok: true; identity: ChainIdentity }
  | {
      ok: false
      reason: 'network-changed'
      expected: ChainIdentity
      actual: ChainIdentity
    }

/**
 * Build a {@link ChainIdentity} for the currently active network.
 *
 * `chainId` is optional so callers that only know the passphrase still get a
 * stable identity; it falls back to the passphrase.
 */
export function getActiveChainIdentity(chainId?: string): ChainIdentity {
  return {
    networkPassphrase,
    chainId: chainId ?? networkPassphrase,
  }
}

/**
 * Compare a previously captured identity against the active network.
 *
 * Returns a typed mismatch result (never throws) so wallet flows can abort and
 * require renewed confirmation after a network switch.
 */
export function checkChainIdentity(
  captured: ChainIdentity,
  active: ChainIdentity = getActiveChainIdentity(captured.chainId),
): ChainIdentityCheck {
  if (
    captured.networkPassphrase !== active.networkPassphrase ||
    captured.chainId !== active.chainId
  ) {
    return {
      ok: false,
      reason: 'network-changed',
      expected: captured,
      actual: active,
    }
  }
  return { ok: true, identity: active }
}

export class StellarService {
  static async getAccountInfo(publicKey: string) {
    try {
      const account = await server.loadAccount(publicKey)
      return account
    } catch {
      throw new Error('Failed to load account information')
    }
  }

  static validateStellarAddress(address: string): boolean {
    try {
      Keypair.fromPublicKey(address)
      return true
    } catch {
      return false
    }
  }

  static formatAmount(amount: string, decimals: number = 7): string {
    const num = parseFloat(amount)
    return num.toFixed(decimals)
  }

  static formatTokenAmount(amount: string, decimals: number = 7): string {
    const num = parseFloat(amount)
    const formatted = num.toFixed(decimals)
    // Only strip trailing zeros when there is a decimal point
    return formatted.includes('.') ? formatted.replace(/\.?0+$/, '') : formatted
  }

  static calculateStreamProgress(stream: StreamRecord): {
    progressPercentage: number
    timeRemaining: string
    ratePerHour: number
  } {
    const now = Date.now()
    const totalDuration = stream.endTime - stream.startTime
    const elapsed = Math.max(0, now - stream.startTime)
    const remaining = Math.max(0, stream.endTime - now)

    const progressPercentage = Math.min(100, (elapsed / totalDuration) * 100)

    const hoursRemaining = Math.ceil(remaining / (1000 * 60 * 60))
    const daysRemaining = Math.floor(hoursRemaining / 24)

    let timeRemaining: string
    if (daysRemaining > 0) {
      timeRemaining = `${daysRemaining}d ${hoursRemaining % 24}h`
    } else {
      timeRemaining = `${hoursRemaining}h`
    }

    const totalHours = totalDuration / (1000 * 60 * 60)
    const ratePerHour = parseFloat(stream.totalAmount) / totalHours

    return {
      progressPercentage,
      timeRemaining,
      ratePerHour,
    }
  }
}
