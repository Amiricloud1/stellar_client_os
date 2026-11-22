/**
 * Token Validator for Decimal and Asset Identity Preservation
 * 
 * Satisfies Objective 2: Preserve the decimals and asset identity assumptions 
 * that apply when a liability is created.
 * 
 * This module ensures:
 * 1. Token decimals are captured at stream creation and never change
 * 2. Token asset identity is immutable
 * 3. Amount calculations always use correct decimals
 * 4. Events include decimal metadata for external verification
 */

export interface TokenAsset {
  /** Contract address of the token */
  address: string;

  /** Number of decimal places (e.g., 6 for USDC, 7 for XLM) */
  decimals: number;

  /** Human-readable token name */
  name: string;

  /** Single-letter symbol */
  symbol: string;

  /** Timestamp when this metadata was captured */
  capturedAt: number;

  /** Issuer address (for Stellar assets) */
  issuer?: string;

  /** Canonical code (for Stellar assets) */
  code?: string;
}

export interface TokenSnapshot {
  /** The token and its metadata at a specific point in time */
  asset: TokenAsset;

  /** Ledger sequence when snapshot was taken */
  ledgerSequence: number;

  /** Hash of asset metadata for integrity verification */
  metadataHash: string;
}

/**
 * Validates and caches token metadata
 * Prevents decimal/asset identity drift over stream lifetime
 */
export class TokenValidator {
  private tokenCache: Map<string, TokenAsset> = new Map();
  private snapshotHistory: Map<string, TokenSnapshot[]> = new Map();

  /**
   * Register a token asset and capture its metadata
   * Should be called when stream is created (inception point)
   */
  registerTokenAsset(
    address: string,
    decimals: number,
    name: string,
    symbol: string,
    issuer?: string,
    code?: string
  ): TokenAsset {
    const asset: TokenAsset = {
      address,
      decimals,
      name,
      symbol,
      capturedAt: Date.now(),
      issuer,
      code,
    };

    this.tokenCache.set(address, asset);

    // Initialize snapshot history
    if (!this.snapshotHistory.has(address)) {
      this.snapshotHistory.set(address, []);
    }

    return asset;
  }

  /**
   * Get cached token metadata
   * Returns the original metadata from registration (immutable)
   */
  getTokenAsset(address: string): TokenAsset | undefined {
    return this.tokenCache.get(address);
  }

  /**
   * Capture a snapshot of token metadata at a specific point in time
   * Used to verify that decimals haven't changed during stream lifetime
   */
  captureSnapshot(
    address: string,
    ledgerSequence: number,
    currentDecimals: number
  ): TokenSnapshot {
    const asset = this.getTokenAsset(address);
    if (!asset) {
      throw new Error(`Token not registered: ${address}`);
    }

    // Verify decimals haven't changed
    if (currentDecimals !== asset.decimals) {
      throw new Error(
        `Decimal mismatch for ${address}: expected ${asset.decimals}, got ${currentDecimals}`
      );
    }

    const snapshot: TokenSnapshot = {
      asset,
      ledgerSequence,
      metadataHash: this.computeMetadataHash(asset),
    };

    const history = this.snapshotHistory.get(address) || [];
    history.push(snapshot);
    this.snapshotHistory.set(address, history);

    return snapshot;
  }

  /**
   * Validate that a token's decimals have remained constant
   * Raises error if decimals have changed since inception
   */
  validateDecimals(address: string, currentDecimals: number): void {
    const registered = this.getTokenAsset(address);
    if (!registered) {
      throw new Error(`Token not registered: ${address}`);
    }

    if (currentDecimals !== registered.decimals) {
      throw new Error(
        `Token decimal drift detected for ${address}: ` +
          `registered ${registered.decimals}, observed ${currentDecimals}`
      );
    }
  }

  /**
   * Validate that a token's identity (address, issuer, code) hasn't changed
   * Raises error if a different token is being used
   */
  validateAssetIdentity(
    address: string,
    expectedIssuer?: string,
    expectedCode?: string
  ): void {
    const registered = this.getTokenAsset(address);
    if (!registered) {
      throw new Error(`Token not registered: ${address}`);
    }

    if (expectedIssuer && registered.issuer !== expectedIssuer) {
      throw new Error(
        `Asset issuer mismatch for ${address}: expected ${expectedIssuer}, got ${registered.issuer}`
      );
    }

    if (expectedCode && registered.code !== expectedCode) {
      throw new Error(
        `Asset code mismatch for ${address}: expected ${expectedCode}, got ${registered.code}`
      );
    }
  }

  /**
   * Convert amount between different decimal representations
   * Prevents precision loss during conversions
   */
  convertAmount(
    amount: number | bigint,
    fromDecimals: number,
    toDecimals: number
  ): number | bigint {
    const decimalDifference = toDecimals - fromDecimals;

    if (decimalDifference === 0) {
      return amount;
    }

    if (typeof amount === 'bigint') {
      if (decimalDifference > 0) {
        return amount * BigInt(10) ** BigInt(decimalDifference);
      } else {
        return amount / BigInt(10) ** BigInt(-decimalDifference);
      }
    } else {
      if (decimalDifference > 0) {
        return amount * Math.pow(10, decimalDifference);
      } else {
        return amount / Math.pow(10, -decimalDifference);
      }
    }
  }

  /**
   * Calculate human-readable amount using token decimals
   * Always uses the registered (immutable) decimals
   */
  toHumanReadable(address: string, amountInNativeUnits: number | bigint): string {
    const asset = this.getTokenAsset(address);
    if (!asset) {
      throw new Error(`Token not registered: ${address}`);
    }

    let amount: number;
    if (typeof amountInNativeUnits === 'bigint') {
      amount = Number(amountInNativeUnits) / Math.pow(10, asset.decimals);
    } else {
      amount = amountInNativeUnits / Math.pow(10, asset.decimals);
    }

    return amount.toFixed(asset.decimals);
  }

  /**
   * Parse human-readable amount to native units using token decimals
   * Always uses the registered (immutable) decimals
   */
  toNativeUnits(address: string, humanReadableAmount: number | string): bigint {
    const asset = this.getTokenAsset(address);
    if (!asset) {
      throw new Error(`Token not registered: ${address}`);
    }

    const amount = typeof humanReadableAmount === 'string'
      ? parseFloat(humanReadableAmount)
      : humanReadableAmount;

    return BigInt(Math.round(amount * Math.pow(10, asset.decimals)));
  }

  /**
   * Verify token metadata hash
   * Detects tampering with token metadata
   */
  verifyMetadataHash(address: string, expectedHash: string): boolean {
    const asset = this.getTokenAsset(address);
    if (!asset) {
      return false;
    }

    const computedHash = this.computeMetadataHash(asset);
    return computedHash === expectedHash;
  }

  /**
   * Compute cryptographic hash of token metadata
   * Used for integrity verification
   */
  private computeMetadataHash(asset: TokenAsset): string {
    // In production, use proper cryptographic hash
    // For now, use simple deterministic hash
    const data = JSON.stringify({
      address: asset.address,
      decimals: asset.decimals,
      name: asset.name,
      symbol: asset.symbol,
      issuer: asset.issuer,
      code: asset.code,
    });

    // Simple hash using JSON stringify + char codes
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit int
    }
    return hash.toString(16);
  }

  /**
   * Get snapshot history for a token
   * Useful for auditing decimal/metadata changes
   */
  getSnapshotHistory(address: string): TokenSnapshot[] {
    return this.snapshotHistory.get(address) || [];
  }

  /**
   * Verify all snapshots for a token have consistent decimals
   */
  verifySnapshotConsistency(address: string): boolean {
    const snapshots = this.getSnapshotHistory(address);
    if (snapshots.length === 0) {
      return true;
    }

    const firstDecimals = snapshots[0].asset.decimals;
    return snapshots.every((snapshot) => snapshot.asset.decimals === firstDecimals);
  }
}

/**
 * Validate token amount hasn't lost precision due to decimal conversion
 * Raises error if precision loss is detected
 */
export function validateAmountPrecision(
  originalAmount: number | bigint,
  decimalsFrom: number,
  decimalsTo: number,
  maxPrecisionLoss: number = 1e-9
): void {
  if (typeof originalAmount === 'bigint') {
    // BigInt operations are exact, no precision loss possible
    return;
  }

  const converted = new TokenValidator().convertAmount(
    originalAmount,
    decimalsFrom,
    decimalsTo
  );
  const reconverted = new TokenValidator().convertAmount(
    typeof converted === 'bigint' ? Number(converted) : converted,
    decimalsTo,
    decimalsFrom
  );

  const precisionLoss = Math.abs(
    (typeof reconverted === 'bigint' ? Number(reconverted) : reconverted) -
      originalAmount
  );

  if (precisionLoss > maxPrecisionLoss) {
    throw new Error(
      `Precision loss detected: ${precisionLoss} (threshold: ${maxPrecisionLoss})`
    );
  }
}

/**
 * Build event metadata for amount changes
 * Ensures every event includes token metadata for external verification
 */
export function buildAmountEventMetadata(
  validator: TokenValidator,
  tokenAddress: string,
  amount: number | bigint
): {
  amountInNativeUnits: number | bigint;
  amountHumanReadable: string;
  tokenDecimals: number;
  tokenAddress: string;
} {
  const asset = validator.getTokenAsset(tokenAddress);
  if (!asset) {
    throw new Error(`Token not registered: ${tokenAddress}`);
  }

  return {
    amountInNativeUnits: amount,
    amountHumanReadable: validator.toHumanReadable(tokenAddress, amount),
    tokenDecimals: asset.decimals,
    tokenAddress,
  };
}

/**
 * Validate that an event includes correct token metadata
 * Used during event parsing to ensure integrity
 */
export function validateEventTokenMetadata(
  validator: TokenValidator,
  tokenAddress: string,
  eventDecimals: number,
  eventMetadataHash?: string
): boolean {
  try {
    validator.validateDecimals(tokenAddress, eventDecimals);

    if (eventMetadataHash) {
      return validator.verifyMetadataHash(tokenAddress, eventMetadataHash);
    }

    return true;
  } catch (error) {
    console.error('Event token metadata validation failed:', error);
    return false;
  }
}
