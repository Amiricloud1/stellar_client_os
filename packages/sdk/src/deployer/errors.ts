/**
 * Typed error classes for the ContractDeployer module.
 */

export class DeployerError extends Error {
  public readonly code: string;
  public readonly originalError?: Error;

  constructor(message: string, code: string, originalError?: Error) {
    super(message);
    this.name = 'DeployerError';
    this.code = code;
    this.originalError = originalError;
    Object.setPrototypeOf(this, DeployerError.prototype);
  }
}

/** Thrown when the provided .wasm buffer is empty or malformed. */
export class InvalidWasmError extends DeployerError {
  constructor(message = 'Invalid or empty WASM buffer', originalError?: Error) {
    super(message, 'INVALID_WASM', originalError);
    this.name = 'InvalidWasmError';
    Object.setPrototypeOf(this, InvalidWasmError.prototype);
  }
}

/** Thrown when the deployer account cannot be loaded from the network. */
export class DeployerAccountError extends DeployerError {
  public readonly address: string;
  constructor(address: string, originalError?: Error) {
    super(`Deployer account not found or unfunded: ${address}`, 'DEPLOYER_ACCOUNT_ERROR', originalError);
    this.name = 'DeployerAccountError';
    this.address = address;
    Object.setPrototypeOf(this, DeployerAccountError.prototype);
  }
}

/** Thrown when the upload (install) transaction fails. */
export class WasmUploadError extends DeployerError {
  public readonly txHash?: string;
  constructor(message: string, txHash?: string, originalError?: Error) {
    super(message, 'WASM_UPLOAD_ERROR', originalError);
    this.name = 'WasmUploadError';
    this.txHash = txHash;
    Object.setPrototypeOf(this, WasmUploadError.prototype);
  }
}

/** Thrown when the contract instantiation transaction fails. */
export class ContractInstantiationError extends DeployerError {
  public readonly txHash?: string;
  constructor(message: string, txHash?: string, originalError?: Error) {
    super(message, 'CONTRACT_INSTANTIATION_ERROR', originalError);
    this.name = 'ContractInstantiationError';
    this.txHash = txHash;
    Object.setPrototypeOf(this, ContractInstantiationError.prototype);
  }
}

/** Thrown when fee/resource simulation fails. */
export class FeeEstimationError extends DeployerError {
  constructor(message: string, originalError?: Error) {
    super(message, 'FEE_ESTIMATION_ERROR', originalError);
    this.name = 'FeeEstimationError';
    Object.setPrototypeOf(this, FeeEstimationError.prototype);
  }
}

/**
 * Thrown when a deployment transaction is not confirmed within
 * the configured timeout period.
 *
 * @remarks
 * The deployer continuously polls the network for confirmation.
 * If the timeout is exceeded, this error is raised.
 *
 * @example
 * ```ts
 * try {
 *   await deployer.deployContract(...);
 * } catch (err) {
 *   if (err instanceof DeploymentTimeoutError) {
 *     console.error('Deployment took too long');
 *   }
 * }
 * ```
 */
/** Thrown when a transaction confirmation times out. */
export class DeploymentTimeoutError extends DeployerError {
  public readonly txHash: string;
  constructor(txHash: string) {
    super(
      `Deployment transaction timed out. It may still be processed. Hash: ${txHash}`,
      'DEPLOYMENT_TIMEOUT'
    );
    this.name = 'DeploymentTimeoutError';
    this.txHash = txHash;
    Object.setPrototypeOf(this, DeploymentTimeoutError.prototype);
  }
}

/**
 * Base class for all deployment-registry failures.
 *
 * @remarks
 * Registry errors are surfaced to operators so that failure and recovery
 * states are explicit. Each subclass carries a stable `code` that can be
 * matched programmatically (e.g. in CI or operational tooling).
 */
export class DeploymentRegistryError extends DeployerError {
  constructor(message: string, code: string, originalError?: Error) {
    super(message, code, originalError);
    this.name = 'DeploymentRegistryError';
    Object.setPrototypeOf(this, DeploymentRegistryError.prototype);
  }
}

/**
 * Thrown when a deployment record fails validation (missing fields,
 * malformed address, unknown network, invalid lifecycle state, etc.).
 *
 * @remarks
 * This is a non-recoverable error: the record must be corrected before it
 * can be written to the registry.
 */
export class InvalidDeploymentRecordError extends DeploymentRegistryError {
  public readonly field?: string;
  constructor(message: string, field?: string, originalError?: Error) {
    super(message, 'INVALID_DEPLOYMENT_RECORD', originalError);
    this.name = 'InvalidDeploymentRecordError';
    this.field = field;
    Object.setPrototypeOf(this, InvalidDeploymentRecordError.prototype);
  }
}

/**
 * Thrown when a caller attempts to mutate the registry without the
 * required authorization (e.g. missing/incorrect writer token).
 *
 * @remarks
 * Non-recoverable without operator intervention: the caller must be granted
 * write access before retrying.
 */
export class UnauthorizedRegistryWriteError extends DeploymentRegistryError {
  public readonly actor?: string;
  constructor(message = 'Unauthorized deployment registry write', actor?: string, originalError?: Error) {
    super(message, 'UNAUTHORIZED_REGISTRY_WRITE', originalError);
    this.name = 'UnauthorizedRegistryWriteError';
    this.actor = actor;
    Object.setPrototypeOf(this, UnauthorizedRegistryWriteError.prototype);
  }
}

/**
 * Thrown when the registry backing store cannot be read or written.
 *
 * @remarks
 * Carries a `recoverable` flag and a `retryHint` so operators can decide
 * whether to retry automatically or escalate. Transient I/O failures are
 * typically recoverable; schema/corruption failures are not.
 */
export class RegistryStorageError extends DeploymentRegistryError {
  public readonly recoverable: boolean;
  public readonly retryHint?: string;
  public readonly operation?: string;
  constructor(
    message: string,
    options: { recoverable?: boolean; retryHint?: string; operation?: string; originalError?: Error } = {}
  ) {
    super(message, 'REGISTRY_STORAGE_ERROR', options.originalError);
    this.name = 'RegistryStorageError';
    this.recoverable = options.recoverable ?? false;
    this.retryHint = options.retryHint;
    this.operation = options.operation;
    Object.setPrototypeOf(this, RegistryStorageError.prototype);
  }
}
