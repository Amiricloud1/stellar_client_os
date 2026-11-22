/**
 * Capability Checker - Typed Capability/Version Surface (Issue #2)
 *
 * Enables clients to declare capabilities and validates that operations are
 * supported before transaction preparation. Prevents late failures at RPC.
 *
 * Usage:
 * ```typescript
 * const checker = new CapabilityChecker(sdkVersion, networkPassphrase);
 * if (!checker.canExecute('payment-stream:create')) {
 *   throw new Error('Operation not supported');
 * }
 * ```
 */

import { rpc } from '@stellar/stellar-sdk';

/**
 * Capability identifier: contract:operation format
 */
export type CapabilityId = string;

/**
 * Set of capabilities this client/SDK supports
 */
export interface ClientCapabilities {
  /** SDK version (e.g., '0.2.0') */
  sdkVersion: string;

  /** Network where capabilities apply (testnet, mainnet, futurenet) */
  network: string;

  /** Supported contract operation IDs */
  supportedOperations: Set<CapabilityId>;

  /** Supported contract versions and their methods */
  contractMethods: Map<string, Set<string>>;

  /** Client metadata for debugging */
  clientId?: string;
  clientVersion?: string;
}

/**
 * Support matrix: tracks what operations are supported in each SDK version
 */
export interface OperationSupportMatrix {
  /** SDK version */
  version: string;

  /** Minimum Soroban SDK version required */
  minSorobanVersion: string;

  /** Network(s) this matrix applies to */
  networks: string[];

  /** Supported contract methods by contract ID */
  contractMethods: Record<string, string[]>;

  /** Deprecated operations (still work but discouraged) */
  deprecated?: Record<string, { since: string; replacement?: string; sunset?: Date }>;

  /** When was this matrix last updated? */
  updatedAt: Date;
}

/**
 * Global operation support matrices (populated at runtime)
 */
const OPERATION_SUPPORT_MATRICES: OperationSupportMatrix[] = [
  {
    version: '0.2.0',
    minSorobanVersion: '27.0.0',
    networks: ['testnet', 'futurenet'],
    contractMethods: {
      'payment-stream': ['create', 'deposit', 'claim_stream_balance', 'pause_stream', 'resume_stream'],
      'distributor': ['distribute', 'claim'],
      'campaign-funding': [
        'create',
        'contribute',
        'claim_milestone_payout',
        'transfer_to_successful',
        'cancel_and_refund',
      ],
      'campaign-escrow': ['deposit', 'withdraw', 'release_escrow'],
    },
    deprecated: {
      'legacy:old_operation': {
        since: '0.1.0',
        replacement: 'new:operation',
        sunset: new Date('2025-12-31'),
      },
    },
    updatedAt: new Date('2024-11-01'),
  },
];

/**
 * Service for checking client capabilities against network constraints
 */
export class CapabilityChecker {
  private readonly sdkVersion: string;
  private readonly network: string;
  private readonly supportMatrix: OperationSupportMatrix;
  private readonly networkInfo?: rpc.ServerApi.NetworkResponse;

  /**
   * @param sdkVersion SDK version string (e.g., '0.2.0')
   * @param network Network name (testnet, mainnet, futurenet)
   * @param networkInfo Optional RPC network info for protocol version checks
   */
  constructor(
    sdkVersion: string,
    network: string,
    networkInfo?: rpc.ServerApi.NetworkResponse
  ) {
    this.sdkVersion = sdkVersion;
    this.network = network;
    this.networkInfo = networkInfo;

    // Find the support matrix for this version
    const matrix = this.findSupportMatrix(sdkVersion, network);
    if (!matrix) {
      throw new Error(
        `No support matrix found for SDK ${sdkVersion} on network ${network}`
      );
    }
    this.supportMatrix = matrix;
  }

  /**
   * Get client capabilities for this checker
   */
  getCapabilities(): ClientCapabilities {
    const contractMethods = new Map<string, Set<string>>();
    const supportedOperations = new Set<CapabilityId>();

    for (const [contract, methods] of Object.entries(this.supportMatrix.contractMethods)) {
      contractMethods.set(contract, new Set(methods));
      methods.forEach((method) => {
        supportedOperations.add(`${contract}:${method}`);
      });
    }

    return {
      sdkVersion: this.sdkVersion,
      network: this.network,
      supportedOperations,
      contractMethods,
    };
  }

  /**
   * Check if an operation is supported
   *
   * @param operationId Operation ID in format 'contract:method'
   * @returns true if operation is supported
   */
  canExecute(operationId: CapabilityId): boolean {
    return this.getCapabilities().supportedOperations.has(operationId);
  }

  /**
   * Check if a contract method is supported
   *
   * @param contract Contract name (e.g., 'payment-stream')
   * @param method Method name (e.g., 'create')
   * @returns true if method is supported
   */
  canExecuteMethod(contract: string, method: string): boolean {
    return this.canExecute(`${contract}:${method}`);
  }

  /**
   * Check if an operation is deprecated
   *
   * @param operationId Operation ID
   * @returns Deprecation info if deprecated, undefined otherwise
   */
  isDeprecated(operationId: CapabilityId): { since: string; replacement?: string; sunset?: Date } | undefined {
    const [contract, method] = operationId.split(':');
    if (!contract || !method) {
      return undefined;
    }

    return this.supportMatrix.deprecated?.[operationId];
  }

  /**
   * Get recommended replacement for a deprecated operation
   *
   * @param operationId Deprecated operation ID
   * @returns Replacement operation ID if available
   */
  getRecommendedReplacement(operationId: CapabilityId): CapabilityId | undefined {
    const deprecation = this.isDeprecated(operationId);
    return deprecation?.replacement as CapabilityId | undefined;
  }

  /**
   * Check protocol version compatibility
   *
   * @returns true if network protocol is compatible with SDK
   */
  isProtocolCompatible(): boolean {
    if (!this.networkInfo?.protocolVersion) {
      // Can't validate without protocol version
      return true;
    }

    // Parse minimum Soroban version requirement
    const minVersion = this.parseVersion(this.supportMatrix.minSorobanVersion);
    const networkVersion = this.networkInfo.protocolVersion;

    // Simple numeric comparison (assumes semver X.Y.Z)
    return networkVersion >= minVersion;
  }

  /**
   * List all supported operations
   *
   * @returns Array of operation IDs
   */
  listSupportedOperations(): CapabilityId[] {
    return Array.from(this.getCapabilities().supportedOperations);
  }

  /**
   * List deprecated operations with sunset info
   *
   * @returns Array of deprecated operation info
   */
  listDeprecatedOperations(): Array<{
    id: CapabilityId;
    since: string;
    replacement?: CapabilityId;
    sunset?: Date;
  }> {
    const deprecated: Array<{
      id: CapabilityId;
      since: string;
      replacement?: CapabilityId;
      sunset?: Date;
    }> = [];

    if (this.supportMatrix.deprecated) {
      for (const [id, info] of Object.entries(this.supportMatrix.deprecated)) {
        deprecated.push({
          id: id as CapabilityId,
          since: info.since,
          replacement: info.replacement as CapabilityId | undefined,
          sunset: info.sunset,
        });
      }
    }

    return deprecated;
  }

  /**
   * Validate an operation is supported before preparation
   * Throws if not supported
   *
   * @param operationId Operation ID
   * @param throwOnDeprecated If true, also throw on deprecated operations
   * @throws Error if operation not supported
   */
  validateCanExecute(operationId: CapabilityId, throwOnDeprecated = false): void {
    if (!this.canExecute(operationId)) {
      throw new Error(
        `Operation '${operationId}' is not supported in SDK ${this.sdkVersion} on network ${this.network}`
      );
    }

    if (throwOnDeprecated && this.isDeprecated(operationId)) {
      const replacement = this.getRecommendedReplacement(operationId);
      throw new Error(
        `Operation '${operationId}' is deprecated (use '${replacement || 'N/A'}' instead)`
      );
    }
  }

  /**
   * Create a capability checker for a specific network
   *
   * @param sdkVersion SDK version
   * @param networkPassphrase Stellar network passphrase
   * @param rpcServer Optional RPC server to fetch network info
   * @returns Initialized capability checker
   */
  static async create(
    sdkVersion: string,
    networkPassphrase: string,
    rpcServer?: rpc.SorobanRpc.Server
  ): Promise<CapabilityChecker> {
    const network = this.networkPassphraseToName(networkPassphrase);
    let networkInfo: rpc.ServerApi.NetworkResponse | undefined;

    if (rpcServer) {
      try {
        const response = await rpcServer.getNetwork();
        networkInfo = response;
      } catch (error) {
        // Network info is optional; continue without it
      }
    }

    return new CapabilityChecker(sdkVersion, network, networkInfo);
  }

  // Helper methods

  private findSupportMatrix(version: string, network: string): OperationSupportMatrix | undefined {
    // Exact version match first
    let matrix = OPERATION_SUPPORT_MATRICES.find(
      (m) => m.version === version && m.networks.includes(network)
    );

    // Fallback to latest compatible version
    if (!matrix) {
      matrix = OPERATION_SUPPORT_MATRICES.filter((m) => m.networks.includes(network))
        .sort((a, b) => this.compareVersions(b.version, a.version))[0];
    }

    return matrix;
  }

  private parseVersion(versionStr: string): number {
    const parts = versionStr.split('.');
    return parseInt(parts[0] ?? '0', 10);
  }

  private compareVersions(a: string, b: string): number {
    const aParts = a.split('.').map((p) => parseInt(p, 10));
    const bParts = b.split('.').map((p) => parseInt(p, 10));

    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aPart = aParts[i] ?? 0;
      const bPart = bParts[i] ?? 0;
      if (aPart !== bPart) {
        return aPart - bPart;
      }
    }

    return 0;
  }

  private static networkPassphraseToName(passphrase: string): string {
    if (passphrase.includes('Test') && passphrase.includes('SDF')) {
      return 'testnet';
    }
    if (passphrase.includes('Public') && passphrase.includes('SDF')) {
      return 'mainnet';
    }
    if (passphrase.includes('Future')) {
      return 'futurenet';
    }
    return 'unknown';
  }
}

/**
 * Register a new operation support matrix
 *
 * @param matrix Matrix to register
 */
export function registerOperationSupportMatrix(matrix: OperationSupportMatrix): void {
  OPERATION_SUPPORT_MATRICES.push(matrix);
  // Sort by version (descending) to have latest first
  OPERATION_SUPPORT_MATRICES.sort((a, b) => {
    const aParts = a.version.split('.').map((p) => parseInt(p, 10));
    const bParts = b.version.split('.').map((p) => parseInt(p, 10));

    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aPart = aParts[i] ?? 0;
      const bPart = bParts[i] ?? 0;
      if (aPart !== bPart) {
        return bPart - aPart;
      }
    }
    return 0;
  });
}

/**
 * Get all registered support matrices
 */
export function getOperationSupportMatrices(): OperationSupportMatrix[] {
  return [...OPERATION_SUPPORT_MATRICES];
}
