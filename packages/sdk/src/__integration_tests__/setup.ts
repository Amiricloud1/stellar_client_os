/**
 * Integration test helpers.
 *
 * Provides utilities for:
 *  - Resolving local-node connection config from environment variables
 *  - Funding test accounts via the local friendbot endpoint
 *  - Deploying contract WASM files to the local node
 *  - Building a minimal native-asset token contract for use in tests
 *
 * Prerequisites (must be running before the test suite starts):
 *   stellar network start local
 *   # or: docker run --rm -p 8000:8000 stellar/quickstart:latest --local
 *
 * The suite will skip gracefully if the local node is unreachable.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  Keypair,
  Networks,
  rpc,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  xdr,
  Contract,
  nativeToScVal,
  Address,
  Account,
  SorobanDataBuilder,
} from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export const LOCAL_RPC_URL =
  process.env.SOROBAN_RPC_URL ?? 'http://localhost:8000/soroban/rpc';

export const LOCAL_NETWORK_PASSPHRASE =
  process.env.SOROBAN_NETWORK_PASSPHRASE ??
  'Standalone Network ; February 2017';

export const PAYMENT_STREAM_WASM_PATH =
  process.env.PAYMENT_STREAM_WASM_PATH ??
  path.resolve(
    __dirname,
    '../../../../contracts/target/wasm32-unknown-unknown/release/payment_stream.wasm',
  );

export const DISTRIBUTOR_WASM_PATH =
  process.env.DISTRIBUTOR_WASM_PATH ??
  path.resolve(
    __dirname,
    '../../../../contracts/target/wasm32-unknown-unknown/release/distributor.wasm',
  );

// ---------------------------------------------------------------------------
// Node reachability check
// ---------------------------------------------------------------------------

/**
 * Returns true when the local Soroban RPC node is reachable.
 * Used to skip tests gracefully when the node is not running.
 */
export async function isLocalNodeReachable(): Promise<boolean> {
  try {
    const server = new rpc.Server(LOCAL_RPC_URL, { allowHttp: true });
    await server.getNetwork();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Account helpers
// ---------------------------------------------------------------------------

/**
 * Fund an account via the local friendbot endpoint.
 * The local quickstart image exposes friendbot at http://localhost:8000/friendbot.
 */
export async function fundAccount(publicKey: string): Promise<void> {
  const friendbotBase = LOCAL_RPC_URL.replace('/soroban/rpc', '');
  const url = `${friendbotBase}/friendbot?addr=${publicKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Friendbot failed for ${publicKey}: ${res.status} ${await res.text()}`,
    );
  }
}

/**
 * Generate a fresh funded Keypair on the local network.
 */
export async function generateFundedKeypair(): Promise<Keypair> {
  const kp = Keypair.random();
  await fundAccount(kp.publicKey());
  return kp;
}

// ---------------------------------------------------------------------------
// Contract deployment helpers
// ---------------------------------------------------------------------------

/**
 * Deploy a WASM contract using stellar-cli.
 * Returns the contract ID (C...) of the deployed instance.
 *
 * Requires `stellar` CLI to be installed and on PATH.
 */
export function deployContractViaCli(options: {
  wasmPath: string;
  sourceKeypair: Keypair;
  rpcUrl?: string;
  networkPassphrase?: string;
}): string {
  const {
    wasmPath,
    sourceKeypair,
    rpcUrl = LOCAL_RPC_URL,
    networkPassphrase = LOCAL_NETWORK_PASSPHRASE,
  } = options;

  if (!fs.existsSync(wasmPath)) {
    throw new Error(
      `WASM file not found at ${wasmPath}. ` +
        `Run 'cargo build --target wasm32-unknown-unknown --release' inside the contracts/ directory first.`,
    );
  }

  const secretKey = sourceKeypair.secret();

  const output = execSync(
    `stellar contract deploy` +
      ` --wasm "${wasmPath}"` +
      ` --source "${secretKey}"` +
      ` --rpc-url "${rpcUrl}"` +
      ` --network-passphrase "${networkPassphrase}"`,
    { encoding: 'utf8' },
  ).trim();

  // stellar-cli prints the contract ID on the last line
  const contractId = output.split('\n').pop()?.trim() ?? '';
  if (!contractId.startsWith('C')) {
    throw new Error(`Unexpected deploy output: ${output}`);
  }
  return contractId;
}

// ---------------------------------------------------------------------------
// SAC (Stellar Asset Contract) helper
// ---------------------------------------------------------------------------

/**
 * Deploy a Stellar Asset Contract for a custom asset so tests have a real
 * token to work with on the local network.
 *
 * Returns the contract ID of the deployed SAC.
 */
export function deployStellarAssetContract(options: {
  issuerKeypair: Keypair;
  assetCode: string;
  rpcUrl?: string;
  networkPassphrase?: string;
}): string {
  const {
    issuerKeypair,
    assetCode,
    rpcUrl = LOCAL_RPC_URL,
    networkPassphrase = LOCAL_NETWORK_PASSPHRASE,
  } = options;

  const output = execSync(
    `stellar contract asset deploy` +
      ` --asset "${assetCode}:${issuerKeypair.publicKey()}"` +
      ` --source "${issuerKeypair.secret()}"` +
      ` --rpc-url "${rpcUrl}"` +
      ` --network-passphrase "${networkPassphrase}"`,
    { encoding: 'utf8' },
  ).trim();

  const contractId = output.split('\n').pop()?.trim() ?? '';
  if (!contractId.startsWith('C')) {
    throw new Error(`Unexpected SAC deploy output: ${output}`);
  }
  return contractId;
}

// ---------------------------------------------------------------------------
// Token minting helper
// ---------------------------------------------------------------------------

/**
 * Mint tokens from a SAC issuer to a recipient address using stellar-cli.
 * Used to give test accounts spendable token balances before running
 * distribution tests.
 */
export async function mintTokens(options: {
  tokenContractId: string;
  issuerKeypair: Keypair;
  recipientAddress: string;
  amount: bigint;
  rpcUrl?: string;
  networkPassphrase?: string;
}): Promise<void> {
  const {
    tokenContractId,
    issuerKeypair,
    recipientAddress,
    amount,
    rpcUrl = LOCAL_RPC_URL,
    networkPassphrase = LOCAL_NETWORK_PASSPHRASE,
  } = options;

  execSync(
    `stellar contract invoke` +
      ` --id "${tokenContractId}"` +
      ` --source "${issuerKeypair.secret()}"` +
      ` --rpc-url "${rpcUrl}"` +
      ` --network-passphrase "${networkPassphrase}"` +
      ` -- mint` +
      ` --to "${recipientAddress}"` +
      ` --amount "${amount}"`,
    { encoding: 'utf8' },
  );
}

// ---------------------------------------------------------------------------
// Transaction signing helper
// ---------------------------------------------------------------------------

/**
 * Returns a signTransaction callback compatible with AssembledTransaction
 * that signs with the provided Keypair.
 */
export function keypairSigner(kp: Keypair) {
  return async (xdr: string): Promise<{ signedTxXdr: string }> => {
    const tx = TransactionBuilder.fromXDR(xdr, LOCAL_NETWORK_PASSPHRASE);
    tx.sign(kp);
    return { signedTxXdr: tx.toXDR() };
  };
}

// ---------------------------------------------------------------------------
// Deterministic fixtures (no live funds required)
// ---------------------------------------------------------------------------

/**
 * A fixed, well-known secret key used to derive deterministic test accounts.
 * This key is public knowledge and MUST never be used on any network that
 * holds real value. It exists purely so integration tests are reproducible.
 */
export const DETERMINISTIC_TEST_SECRET =
  'SDETERMINISTICINTEGRATIONTESTKEY000000000000000000000000000';

/**
 * Derive a deterministic Keypair from a numeric index. Useful for building
 * stable fixtures without touching friendbot or live funds.
 */
export function deterministicKeypair(index = 0): Keypair {
  // Derive a stable 32-byte seed from the index so each call is reproducible.
  const seed = Buffer.alloc(32);
  seed.writeUInt32BE(index >>> 0, 0);
  seed.write('soroban-lifecycle-test', 4, 'utf8');
  return Keypair.fromRawEd25519Seed(seed);
}

/**
 * Build a deterministic, unsigned Soroban invocation transaction envelope
 * suitable for exercising simulation/signing/submission flows offline.
 */
export function buildDeterministicInvocationTx(options: {
  source: Keypair;
  contractId: string;
  method: string;
  args?: xdr.ScVal[];
  fee?: string;
  sequence?: string;
}): ReturnType<typeof TransactionBuilder.prototype.build> {
  const {
    source,
    contractId,
    method,
    args = [],
    fee = BASE_FEE,
    sequence = '0',
  } = options;

  const account = new Account(source.publicKey(), sequence);
  const contract = new Contract(contractId);

  return new TransactionBuilder(account, {
    fee,
    networkPassphrase: LOCAL_NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
}

/**
 * Build a deterministic contract event XDR for decoding tests. Produces a
 * `contract` event with the given topics and value, wrapped in the
 * `DiagnosticEvent`-free `TransactionEvent` shape returned by RPC.
 */
export function buildContractEventXdr(options: {
  contractId: string;
  topics: xdr.ScVal[];
  value: xdr.ScVal;
  ledger?: number;
  txHash?: string;
}): xdr.DiagnosticEvent {
  const {
    contractId,
    topics,
    value,
    ledger = 1,
    txHash = '00'.repeat(32),
  } = options;

  const contractEventBody = new xdr.ContractEventV0({
    topics,
    data: value,
  });

  const contractEvent = new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: Address.fromString(contractId).toScAddress(),
    type: xdr.ContractEventType.contract(),
    body: xdr.ContractEventBody.v0(contractEventBody),
  });

  const txEvent = new xdr.TransactionEvent({
    ext: new xdr.ExtensionPoint(0),
    stage: xdr.TransactionEventStage.afterAllTxs(),
    event: contractEvent,
  });

  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: txEvent,
  });
}

/**
 * Convenience: build a topic ScVal from a symbol string.
 */
export function symbolTopic(symbol: string): xdr.ScVal {
  return nativeToScVal(symbol, { type: 'symbol' });
}

/**
 * Convenience: build a u32/u64/i128 value ScVal.
 */
export function u64Value(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: 'u64' });
}

/**
 * Attach a deterministic Soroban transaction data footprint to a transaction
 * so it can be simulated without prior ledger state.
 */
export function withDeterministicFootprint(
  tx: ReturnType<typeof TransactionBuilder.prototype.build>,
  contractId: string,
): ReturnType<typeof TransactionBuilder.prototype.build> {
  const data = new SorobanDataBuilder()
    .setReadOnly([new Contract(contractId).address().toScAddress()])
    .build();
  tx.setSorobanData(data);
  return tx;
}
