import {
  TransactionBuilder,
  Operation,
  xdr,
  Address,
  Account,
  hash,
  StrKey,
  Transaction,
} from '@stellar/stellar-sdk';
import { Server as RpcServer, Api, assembleTransaction } from '@stellar/stellar-sdk/rpc';
import { getStellarServerOptions } from '@/utils/rpc-connection-options';

interface DeployConfig {
  rpcUrl: string;
  networkPassphrase: string;
}

/**
 * Resource limits applied to public contract compilation / WASM uploads.
 *
 * These bounds protect the deployer service from oversized or untrusted
 * inputs. All values are intentionally conservative and can be overridden
 * per-deployer via {@link DeployConfig.limits} for trusted/internal callers.
 *
 * - `maxWasmBytes`        — Maximum accepted WASM payload size (bytes).
 * - `maxRequestBytes`     — Maximum accepted total request size (bytes).
 * - `maxCpuInstructions`  — Maximum simulated CPU instruction budget.
 * - `maxConcurrent`       — Maximum in-flight compilation/upload operations.
 * - `timeoutMs`           — Wall-clock timeout for a single operation.
 * - `maxOutputBytes`      — Maximum accepted serialized output size (bytes).
 */
export interface CompilationLimits {
  maxWasmBytes: number;
  maxRequestBytes: number;
  maxCpuInstructions: number;
  maxConcurrent: number;
  timeoutMs: number;
  maxOutputBytes: number;
}

export const DEFAULT_COMPILATION_LIMITS: Readonly<CompilationLimits> = Object.freeze({
  maxWasmBytes: 256 * 1024, // 256 KiB
  maxRequestBytes: 512 * 1024, // 512 KiB
  maxCpuInstructions: 100_000_000,
  maxConcurrent: 4,
  timeoutMs: 30_000,
  maxOutputBytes: 1024 * 1024, // 1 MiB
});

/**
 * Stable error codes emitted when a compilation resource limit is violated.
 * Callers (and the API layer) should branch on these codes rather than on
 * human-readable messages.
 */
export type CompilationErrorCode =
  | 'COMPILATION_WASM_TOO_LARGE'
  | 'COMPILATION_REQUEST_TOO_LARGE'
  | 'COMPILATION_CPU_BUDGET_EXCEEDED'
  | 'COMPILATION_CONCURRENCY_LIMIT'
  | 'COMPILATION_TIMEOUT'
  | 'COMPILATION_OUTPUT_TOO_LARGE';

export class CompilationLimitError extends Error {
  readonly code: CompilationErrorCode;

  constructor(code: CompilationErrorCode, message: string) {
    super(message);
    this.name = 'CompilationLimitError';
    this.code = code;
  }
}
=======

export class ContractDeployer {
  private rpcServer: RpcServer;
  private networkPassphrase: string;
  private limits: CompilationLimits;
  private inFlight = 0;

  constructor(config: DeployConfig & { limits?: Partial<CompilationLimits> }) {
    this.rpcServer = new RpcServer(config.rpcUrl, getStellarServerOptions(config.rpcUrl));
    this.networkPassphrase = config.networkPassphrase;
    this.limits = { ...DEFAULT_COMPILATION_LIMITS, ...(config.limits ?? {}) };
  }

  /** Returns the effective compilation limits (read-only copy). */
  getLimits(): Readonly<CompilationLimits> {
    return { ...this.limits };
  }

  /**
   * Validates the WASM payload and request size against the configured limits.
   * Throws a {@link CompilationLimitError} with a stable code on violation.
   */
  private assertWasmWithinLimits(wasmBytes: Uint8Array): void {
    if (wasmBytes.byteLength > this.limits.maxWasmBytes) {
      throw new CompilationLimitError(
        'COMPILATION_WASM_TOO_LARGE',
        `WASM payload of ${wasmBytes.byteLength} bytes exceeds limit of ${this.limits.maxWasmBytes} bytes.`
      );
    }
    if (wasmBytes.byteLength > this.limits.maxRequestBytes) {
      throw new CompilationLimitError(
        'COMPILATION_REQUEST_TOO_LARGE',
        `Request of ${wasmBytes.byteLength} bytes exceeds limit of ${this.limits.maxRequestBytes} bytes.`
      );
    }
  }

  /**
   * Runs `fn` under the concurrency and timeout bounds. Rejects with a stable
   * {@link CompilationLimitError} when the concurrency limit is exceeded or the
   * operation exceeds the wall-clock timeout.
   */
  private async withResourceBounds<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.limits.maxConcurrent) {
      throw new CompilationLimitError(
        'COMPILATION_CONCURRENCY_LIMIT',
        `Concurrency limit of ${this.limits.maxConcurrent} reached.`
      );
    }
    this.inFlight++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new CompilationLimitError(
              'COMPILATION_TIMEOUT',
              `Operation exceeded timeout of ${this.limits.timeoutMs}ms.`
            )
          );
        }, this.limits.timeoutMs);
      });
      return await Promise.race([fn(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.inFlight--;
    }
  }

  /**
   * Asserts the simulated CPU instruction budget and serialized output size.
   */
  private assertSimulationWithinLimits(simulation: Api.SimulateTransactionSuccessResponse): void {
    const cost = simulation.cost;
    if (cost && typeof cost.cpuInsns === 'string') {
      const cpuInsns = Number(cost.cpuInsns);
      if (Number.isFinite(cpuInsns) && cpuInsns > this.limits.maxCpuInstructions) {
        throw new CompilationLimitError(
          'COMPILATION_CPU_BUDGET_EXCEEDED',
          `Simulated CPU instructions (${cpuInsns}) exceed limit of ${this.limits.maxCpuInstructions}.`
        );
      }
    }
    const result = simulation.result;
    if (result) {
      const outputBytes = result.retval.toXDR().byteLength;
      if (outputBytes > this.limits.maxOutputBytes) {
        throw new CompilationLimitError(
          'COMPILATION_OUTPUT_TOO_LARGE',
          `Simulation output of ${outputBytes} bytes exceeds limit of ${this.limits.maxOutputBytes} bytes.`
        );
      }
    }
  }

  /**
   * Builds the transaction to upload a WASM file to the network.
   *
   * Resource limits (see {@link CompilationLimits}):
   * - WASM payload must not exceed `maxWasmBytes` / `maxRequestBytes`
   *   (`COMPILATION_WASM_TOO_LARGE`, `COMPILATION_REQUEST_TOO_LARGE`).
   * - At most `maxConcurrent` uploads may be in flight
   *   (`COMPILATION_CONCURRENCY_LIMIT`).
   * - The whole operation must complete within `timeoutMs`
   *   (`COMPILATION_TIMEOUT`).
   * - Simulated CPU instructions must not exceed `maxCpuInstructions`
   *   (`COMPILATION_CPU_BUDGET_EXCEEDED`).
   * - Serialized simulation output must not exceed `maxOutputBytes`
   *   (`COMPILATION_OUTPUT_TOO_LARGE`).
   */
  async buildUploadWasmTx(
    address: string,
    wasmBytes: Uint8Array,
    fee: string = '1000' // Increased default fee for Wasm upload
  ): Promise<{ transaction: Transaction; simulation: Api.SimulateTransactionSuccessResponse }> {
    this.assertWasmWithinLimits(wasmBytes);

    return this.withResourceBounds(async () => {
      const account = await this.getAccount(address);

      // Convert Uint8Array to Buffer for the SDK
      const wasmBuffer = Buffer.from(wasmBytes);

      const tx = new TransactionBuilder(account, {
        fee,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeHostFunction({
            func: xdr.HostFunction.hostFunctionTypeUploadContractWasm(wasmBuffer),
            auth: [],
          })
        )
        .setTimeout(60) // Generous timeout for uploads
        .build();

      const simulation = await this.rpcServer.simulateTransaction(tx);

      if (Api.isSimulationError(simulation)) {
        throw new Error(`Wait! Wasm upload simulation failed: ${simulation.error}`);
      }

      this.assertSimulationWithinLimits(simulation);

      const assembledTx = assembleTransaction(tx, simulation).build();
      return { transaction: assembledTx, simulation };
    });
  }

  /**
   * Submit transaction and wait for confirmation, returning the result.
   */
  async submitSignedTransaction(signedTxXdr: string): Promise<Api.GetSuccessfulTransactionResponse> {
    const tx = TransactionBuilder.fromXDR(signedTxXdr, this.networkPassphrase);
    const sendResponse = await this.rpcServer.sendTransaction(tx);

    if (sendResponse.status === 'ERROR') {
      throw new Error('Transaction submission failed: ' + JSON.stringify(sendResponse.errorResult));
    }

    // Poll for status
    let getResponse = await this.rpcServer.getTransaction(sendResponse.hash);
    const maxRetries = 30; // 30 seconds wait
    let retries = 0;

    while (getResponse.status === 'NOT_FOUND' && retries < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      getResponse = await this.rpcServer.getTransaction(sendResponse.hash);
      retries++;
    }

    if (getResponse.status !== 'SUCCESS') {
      let errorMessage = `Wait! Transaction failed with status: ${getResponse.status}`;
      if (getResponse.status === 'FAILED') {
         errorMessage += ` — ${JSON.stringify(getResponse.resultMetaXdr)}`;
      }
      throw new Error(errorMessage);
    }
    
    return getResponse;
  }

  /**
   * Helper to parse WASM hash from a successful upload getTransaction response
   */
  parseWasmHashFromUpload(getResponse: unknown): Buffer {
    let wasmHash: Buffer | undefined;
    const meta = (getResponse as { resultMetaXdr?: xdr.TransactionMeta }).resultMetaXdr;
    
    if (meta) {
      const sorobanMeta = meta.v3()?.sorobanMeta();
      const retVal = sorobanMeta?.returnValue();
      if (retVal && retVal.switch() === xdr.ScValType.scvBytes()) {
        wasmHash = retVal.bytes();
      }
    }
    
    if (!wasmHash) {
      throw new Error('Wait! Could not parse WASM hash from the upload transaction result. Maybe the simulation was out of sync?');
    }
    return wasmHash;
  }

  /**
   * Derives the contract ID deterministically from the deployer address, salt,
   * and network passphrase — **before** any transaction is submitted.
   *
   * This mirrors the on-chain logic exactly:
   *   SHA-256( HashIdPreimage{ networkId: SHA-256(passphrase), preimage: ContractIdPreimageFromAddress } )
   * encoded as a Stellar contract strkey (C…).
   *
   * @param deployerAddress  - G… Stellar account address of the deployer.
   * @param salt             - 32-byte salt used in the create-contract transaction.
   * @param networkPassphrase - Network passphrase (e.g. "Test SDF Network ; September 2015").
   * @returns The contract address (C…) that will be assigned on deployment.
   */
  static deriveContractId(
    deployerAddress: string,
    salt: Buffer,
    networkPassphrase: string,
  ): string {
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
      new xdr.HashIdPreimageContractId({
        networkId: hash(Buffer.from(networkPassphrase)),
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
          new xdr.ContractIdPreimageFromAddress({
            address: new Address(deployerAddress).toScAddress(),
            salt,
          })
        ),
      })
    );
    return StrKey.encodeContract(hash(preimage.toXDR()));
  }

  /**
   * Builds the transaction to create a contract instance from an uploaded WASM hash.
   *
   * The salt can be supplied by the caller so the contract ID can be derived
   * ahead of time via `ContractDeployer.deriveContractId()`. If omitted, a
   * cryptographically random 32-byte salt is generated and returned alongside
   * the transaction so the caller can still derive the expected contract ID.
   *
   * @param address  - Deployer's Stellar account address.
   * @param wasmHash - 32-byte WASM hash returned by the upload step.
   * @param salt     - Optional 32-byte salt. A random one is generated when omitted.
   * @param fee      - Base fee in stroops.
   * @returns The assembled transaction, the simulation result, and the salt used.
   */
  async buildCreateContractTx(
    address: string,
    wasmHash: Buffer,
    salt?: Buffer,
    fee: string = '1000',
  ): Promise<{ transaction: Transaction; simulation: Api.SimulateTransactionSuccessResponse; salt: Buffer }> {
    if (wasmHash.byteLength > this.limits.maxRequestBytes) {
      throw new CompilationLimitError(
        'COMPILATION_REQUEST_TOO_LARGE',
        `Request of ${wasmHash.byteLength} bytes exceeds limit of ${this.limits.maxRequestBytes} bytes.`
      );
    }

    return this.withResourceBounds(async () => {
      const account = await this.getAccount(address);

      // Use the provided salt or generate a cryptographically random one.
      const saltBuffer: Buffer = salt ?? (() => {
        const buf = new Uint8Array(32);
        crypto.getRandomValues(buf);
        return Buffer.from(buf);
      })();

      const func = xdr.HostFunction.hostFunctionTypeCreateContract(
        new xdr.CreateContractArgs({
          contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
            new xdr.ContractIdPreimageFromAddress({
              address: new Address(address).toScAddress(),
              salt: saltBuffer,
            })
          ),
          executable: xdr.ContractExecutable.contractExecutableWasm(wasmHash),
        })
      );

      const tx = new TransactionBuilder(account, {
        fee,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeHostFunction({
            func,
            auth: [],
          })
        )
        .setTimeout(60)
        .build();

      const simulation = await this.rpcServer.simulateTransaction(tx);

      if (Api.isSimulationError(simulation)) {
        throw new Error(`Wait! Create contract simulation failed: ${simulation.error}`);
      }

      this.assertSimulationWithinLimits(simulation);

      const assembledTx = assembleTransaction(tx, simulation).build();
      return { transaction: assembledTx, simulation, salt: saltBuffer };
    });
  }
  
  /**
   * Helper to parse Contract ID from a successful create getTransaction response
   */
  parseContractIdFromCreate(getResponse: unknown): string {
    let contractAddress: string | undefined;
    const meta = (getResponse as { resultMetaXdr?: xdr.TransactionMeta }).resultMetaXdr;
    
    if (meta) {
      const sorobanMeta = meta.v3()?.sorobanMeta();
      const retVal = sorobanMeta?.returnValue();
      if (retVal && retVal.switch() === xdr.ScValType.scvAddress()) {
        contractAddress = Address.fromScAddress(retVal.address()).toString();
      }
    }
    
    if (!contractAddress) {
       throw new Error('Wait! Could not parse Contract ID from the creation transaction result.');
    }
    
    return contractAddress;
  }

  private async getAccount(address: string): Promise<Account> {
    try {
      const account = await this.rpcServer.getAccount(address);
      return account;
    } catch {
       throw new Error("Wait! Account not found on the network. Is it funded with XLM?");
    }
  }
}
