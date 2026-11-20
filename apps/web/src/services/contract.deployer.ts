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

/**
 * Categories of pre-launch readiness checks. Each category is validated
 * independently so operators can see exactly what must be fixed before a
 * campaign can be deployed.
 */
export type ReadinessCategory =
  | 'metadata'
  | 'network'
  | 'assetSupport'
  | 'milestones'
  | 'payoutTerms';

export const READINESS_CATEGORIES: readonly ReadinessCategory[] = Object.freeze([
  'metadata',
  'network',
  'assetSupport',
  'milestones',
  'payoutTerms',
]);

/**
 * A single item in the pre-launch readiness checklist.
 *
 * - `category`  — Which readiness area the item belongs to.
 * - `id`        — Stable identifier for the check (safe to branch on).
 * - `passed`    — Whether the check succeeded.
 * - `message`   — Human-readable, operator-facing explanation.
 */
export interface ReadinessCheckItem {
  category: ReadinessCategory;
  id: string;
  passed: boolean;
  message: string;
}

/**
 * Structured result of a readiness validation run.
 *
 * - `ready`  — True only when every check passed.
 * - `items`  — The full checklist (both passing and failing items).
 * - `failed` — Convenience list of only the failing items.
 */
export interface ReadinessReport {
  ready: boolean;
  items: ReadinessCheckItem[];
  failed: ReadinessCheckItem[];
}

/**
 * Campaign metadata required before deployment.
 */
export interface CampaignMetadata {
  name?: string;
  description?: string;
  owner?: string;
}

/**
 * Milestone definition used for readiness validation.
 */
export interface CampaignMilestone {
  title?: string;
  amount?: string | number;
  dueDate?: string | Date;
}

/**
 * Payout terms used for readiness validation.
 */
export interface PayoutTerms {
  assetCode?: string;
  assetIssuer?: string;
  totalAmount?: string | number;
  /** Whether the payout asset is a native (XLM) asset. */
  native?: boolean;
}

/**
 * Inputs to the pre-launch readiness validator.
 */
export interface CampaignReadinessInput {
  /** Campaign metadata (name, description, owner). */
  metadata?: CampaignMetadata;
  /** Network the campaign will be deployed to. */
  network?: {
    networkPassphrase?: string;
    rpcUrl?: string;
  };
  /** Assets the campaign will accept / pay out. */
  assets?: {
    supported?: string[];
    required?: string[];
  };
  /** Milestones the campaign defines. */
  milestones?: CampaignMilestone[];
  /** Payout terms for the campaign. */
  payoutTerms?: PayoutTerms;
  /** Address of the account attempting the deployment (authorization). */
  deployerAddress?: string;
  /** Addresses authorized to deploy the campaign. */
  authorizedDeployers?: string[];
}

/**
 * Raised when a deployment is attempted while the readiness checklist has
 * failing items. Carries the full {@link ReadinessReport} so operators can
 * surface every problem at once and retry after fixes.
 */
export class ReadinessError extends Error {
  readonly code = 'DEPLOYMENT_NOT_READY' as const;
  readonly report: ReadinessReport;

  constructor(report: ReadinessReport) {
    const summary = report.failed
      .map((item) => `[${item.category}] ${item.message}`)
      .join('; ');
    super(`Deployment blocked: campaign is not ready. ${summary}`);
    this.name = 'ReadinessError';
    this.report = report;
  }
}

/**
 * Validates campaign readiness before deployment. Returns a structured
 * checklist covering metadata, network, asset support, milestones, and payout
 * terms. This is a pure function so it can be reused by the API layer and by
 * the deployer's authoritative pre-deployment gate.
 */
export function validateCampaignReadiness(input: CampaignReadinessInput): ReadinessReport {
  const items: ReadinessCheckItem[] = [];

  const push = (
    category: ReadinessCategory,
    id: string,
    passed: boolean,
    message: string
  ): void => {
    items.push({ category, id, passed, message });
  };

  // --- Metadata -----------------------------------------------------------
  const name = input.metadata?.name?.trim();
  push(
    'metadata',
    'metadata.name',
    Boolean(name),
    name ? 'Campaign name is set.' : 'Campaign name is required.'
  );

  const description = input.metadata?.description?.trim();
  push(
    'metadata',
    'metadata.description',
    Boolean(description),
    description ? 'Campaign description is set.' : 'Campaign description is required.'
  );

  const owner = input.metadata?.owner?.trim();
  push(
    'metadata',
    'metadata.owner',
    Boolean(owner),
    owner ? 'Campaign owner is set.' : 'Campaign owner address is required.'
  );

  // --- Network ------------------------------------------------------------
  const passphrase = input.network?.networkPassphrase?.trim();
  push(
    'network',
    'network.passphrase',
    Boolean(passphrase),
    passphrase
      ? 'Network passphrase is configured.'
      : 'Network passphrase is required.'
  );

  const rpcUrl = input.network?.rpcUrl?.trim();
  const rpcValid = Boolean(rpcUrl) && /^https?:\/\//i.test(rpcUrl as string);
  push(
    'network',
    'network.rpcUrl',
    rpcValid,
    rpcValid
      ? 'RPC URL is configured.'
      : 'A valid http(s) RPC URL is required.'
  );

  // --- Asset support ------------------------------------------------------
  const supported = input.assets?.supported ?? [];
  const required = input.assets?.required ?? [];
  const supportedSet = new Set(supported);
  const missingAssets = required.filter((asset) => !supportedSet.has(asset));
  push(
    'assetSupport',
    'assets.requiredSupported',
    required.length > 0 && missingAssets.length === 0,
    required.length === 0
      ? 'At least one required asset must be declared.'
      : missingAssets.length === 0
        ? 'All required assets are supported.'
        : `Unsupported required asset(s): ${missingAssets.join(', ')}.`
  );

  // --- Milestones ---------------------------------------------------------
  const milestones = input.milestones ?? [];
  const milestonesValid =
    milestones.length > 0 &&
    milestones.every((m) => {
      const title = m.title?.trim();
      const amount = Number(m.amount);
      const hasAmount = Number.isFinite(amount) && amount > 0;
      const hasDue = Boolean(m.dueDate);
      return Boolean(title) && hasAmount && hasDue;
    });
  push(
    'milestones',
    'milestones.valid',
    milestonesValid,
    milestones.length === 0
      ? 'At least one milestone is required.'
      : milestonesValid
        ? 'All milestones have a title, positive amount, and due date.'
        : 'Every milestone must have a title, a positive amount, and a due date.'
  );

  // --- Payout terms -------------------------------------------------------
  const terms = input.payoutTerms;
  const native = terms?.native === true;
  const assetCode = terms?.assetCode?.trim();
  const assetIssuer = terms?.assetIssuer?.trim();
  const totalAmount = Number(terms?.totalAmount);
  const hasTotal = Number.isFinite(totalAmount) && totalAmount > 0;
  const assetOk = native ? true : Boolean(assetCode) && Boolean(assetIssuer);
  const payoutValid = hasTotal && assetOk;
  push(
    'payoutTerms',
    'payoutTerms.valid',
    payoutValid,
    !hasTotal
      ? 'Payout total amount must be a positive number.'
      : !assetOk
        ? 'Payout asset code and issuer are required (or mark the asset as native).'
        : 'Payout terms are complete.'
  );

  // --- Authorization ------------------------------------------------------
  const deployer = input.deployerAddress?.trim();
  const authorized = input.authorizedDeployers ?? [];
  const authorizedOk =
    Boolean(deployer) && authorized.length > 0 && authorized.includes(deployer as string);
  push(
    'metadata',
    'authorization.deployer',
    authorizedOk,
    authorizedOk
      ? 'Deployer is authorized.'
      : 'Deployer address is not authorized to deploy this campaign.'
  );

  const failed = items.filter((item) => !item.passed);
  return { ready: failed.length === 0, items, failed };
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

  /**
   * Authoritative pre-deployment readiness gate.
   *
   * Runs the full pre-launch checklist (metadata, network, asset support,
   * milestones, payout terms, and deployer authorization) and throws a
   * {@link ReadinessError} carrying the structured report if any item fails.
   * This must be called before any deployment transaction is built or
   * submitted so that invalid campaigns are blocked at the boundary.
   *
   * @returns The passing {@link ReadinessReport} when the campaign is ready.
   */
  assertReadyForDeployment(input: CampaignReadinessInput): ReadinessReport {
    const report = validateCampaignReadiness(input);
    if (!report.ready) {
      throw new ReadinessError(report);
    }
    return report;
  }

  /**
   * Builds the create-contract transaction only after the campaign passes the
   * pre-launch readiness checklist. Fails fast with a {@link ReadinessError}
   * (and never contacts the network) when the campaign is not ready.
   */
  async buildCreateContractTxIfReady(
    readiness: CampaignReadinessInput,
    address: string,
    wasmHash: Buffer,
    salt?: Buffer,
    fee: string = '1000',
  ): Promise<{ transaction: Transaction; simulation: Api.SimulateTransactionSuccessResponse; salt: Buffer }> {
    this.assertReadyForDeployment(readiness);
    return this.buildCreateContractTx(address, wasmHash, salt, fee);
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
