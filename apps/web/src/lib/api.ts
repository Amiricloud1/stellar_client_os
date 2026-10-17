import type { AssembledTransaction } from '@stellar/stellar-sdk/contract';
import { PAYMENT_STREAM_CONTRACT_ID, DISTRIBUTOR_CONTRACT_ID } from '@/lib/env';
import { SOROBAN_RPC_URL, NETWORK_PASSPHRASE } from '@/lib/constants';
import { env } from '@/lib/env';
import { throwIfAborted } from '@/utils/retry';
import { StellarService, type Stream as ServiceStream, type AccountInfo } from '@/services';
import { PaymentStreamClient } from '../../../../packages/sdk/src/PaymentStreamClient';
import { DistributorClient } from '../../../../packages/sdk/src/DistributorClient';
import { createBatches } from '../../../../packages/sdk/src/utils/batchDistribution';
import { Stream, StreamStatus } from '../types';

type WalletSigner = (xdr: string) => Promise<string>;

/**
 * Idempotency contract for financial mutation endpoints.
 *
 * Scope
 * -----
 * A key is scoped to the authenticated actor (wallet address) plus the
 * operation name. The same key may therefore be reused by a different actor
 * or for a different operation without colliding. Keys are opaque client
 * generated strings (1-255 chars, `[A-Za-z0-9._:-]`).
 *
 * Retention
 * ---------
 * Completed entries are retained for `IDEMPOTENCY_RETENTION_MS` (24h). Entries
 * still in-flight are retained until they complete or `IDEMPOTENCY_LOCK_MS`
 * (60s) elapses, after which a retry may take over the lock. Expired entries
 * are treated as absent.
 *
 * Conflict behavior
 * -----------------
 * - Same key + same payload hash  -> cached result is replayed (no re-submit).
 * - Same key + different payload  -> `IdempotencyConflictError` (HTTP 409).
 * - Same key while in-flight      -> `IdempotencyInFlightError` (HTTP 409/425).
 * - Missing/invalid key           -> `IdempotencyKeyError` (HTTP 400).
 */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_LOCK_MS = 60 * 1000;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;

export class IdempotencyKeyError extends Error {
    readonly status = 400;
    constructor(message = `Missing or invalid ${IDEMPOTENCY_HEADER} header`) {
        super(message);
        this.name = 'IdempotencyKeyError';
    }
}

export class IdempotencyConflictError extends Error {
    readonly status = 409;
    constructor(message = 'Idempotency key was reused with a different payload') {
        super(message);
        this.name = 'IdempotencyConflictError';
    }
}

export class IdempotencyInFlightError extends Error {
    readonly status = 409;
    constructor(message = 'A request with this idempotency key is already in flight') {
        super(message);
        this.name = 'IdempotencyInFlightError';
    }
}

export interface IdempotencyRecord<T = unknown> {
    payloadHash: string;
    status: 'in_flight' | 'completed';
    result?: T;
    createdAt: number;
    completedAt?: number;
}

export interface IdempotencyStore {
    get(scope: string): Promise<IdempotencyRecord | undefined> | IdempotencyRecord | undefined;
    set(scope: string, record: IdempotencyRecord): Promise<void> | void;
    delete(scope: string): Promise<void> | void;
}

/** In-memory default store; swap for a durable store in production. */
export function createInMemoryIdempotencyStore(): IdempotencyStore {
    const map = new Map<string, IdempotencyRecord>();
    return {
        get: (scope) => map.get(scope),
        set: (scope, record) => {
            map.set(scope, record);
        },
        delete: (scope) => {
            map.delete(scope);
        },
    };
}

let idempotencyStore: IdempotencyStore = createInMemoryIdempotencyStore();

export function setIdempotencyStore(store: IdempotencyStore): void {
    idempotencyStore = store;
}

export function validateIdempotencyKey(key: string | null | undefined): string {
    if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
        throw new IdempotencyKeyError();
    }
    return key;
}

/** Deterministic JSON serialization so payload hashes are stable. */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const entries = Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
}

/** FNV-1a 64-bit hash rendered as hex; sufficient for change detection. */
export function computePayloadHash(payload: unknown): string {
    const input = stableStringify(payload);
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    for (let i = 0; i < input.length; i++) {
        hash ^= BigInt(input.charCodeAt(i));
        hash = (hash * prime) & mask;
    }
    return hash.toString(16).padStart(16, '0');
}

export function buildIdempotencyScope(actor: string, operation: string, key: string): string {
    return `${actor}:${operation}:${key}`;
}

export interface IdempotencyOutcome<T> {
    replayed: boolean;
    result: T;
}

/**
 * Runs `operation` under an idempotency key. Returns the cached result when the
 * key was already completed with the same payload, throws on payload mismatch
 * or concurrent in-flight duplicates, and otherwise executes and persists the
 * result atomically (store write happens only after success).
 */
export async function withIdempotency<T>(
    params: {
        key: string | null | undefined;
        actor: string;
        operation: string;
        payload: unknown;
    },
    operation: () => Promise<T>
): Promise<IdempotencyOutcome<T>> {
    const key = validateIdempotencyKey(params.key);
    const scope = buildIdempotencyScope(params.actor, params.operation, key);
    const payloadHash = computePayloadHash(params.payload);
    const now = Date.now();

    const existing = await idempotencyStore.get(scope);
    if (existing) {
        const expired =
            existing.status === 'completed'
                ? now - (existing.completedAt ?? existing.createdAt) > IDEMPOTENCY_RETENTION_MS
                : now - existing.createdAt > IDEMPOTENCY_LOCK_MS;

        if (!expired) {
            if (existing.payloadHash !== payloadHash) {
                throw new IdempotencyConflictError();
            }
            if (existing.status === 'in_flight') {
                throw new IdempotencyInFlightError();
            }
            return { replayed: true, result: existing.result as T };
        }
        await idempotencyStore.delete(scope);
    }

    await idempotencyStore.set(scope, {
        payloadHash,
        status: 'in_flight',
        createdAt: now,
    });

    try {
        const result = await operation();
        await idempotencyStore.set(scope, {
            payloadHash,
            status: 'completed',
            result,
            createdAt: now,
            completedAt: Date.now(),
        });
        return { replayed: false, result };
    } catch (error) {
        // Failed attempts release the key so the client may retry.
        await idempotencyStore.delete(scope);
        throw error;
    }
}

function deriveHorizonUrl(): string {
    if (env.NEXT_PUBLIC_STELLAR_HORIZON_URL) return env.NEXT_PUBLIC_STELLAR_HORIZON_URL;
    if (env.NEXT_PUBLIC_STELLAR_NETWORK === 'mainnet') return 'https://horizon.stellar.org';
    if (SOROBAN_RPC_URL) {
        const { protocol, hostname, port } = new URL(SOROBAN_RPC_URL);
        const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
        if (isLocalhost) return `${protocol}//${hostname}${port ? `:${port}` : ''}`;
    }
    return 'https://horizon-testnet.stellar.org';
}

const HORIZON_URL = deriveHorizonUrl();

const stellarService = new StellarService({
    network: {
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: SOROBAN_RPC_URL,
        horizonUrl: HORIZON_URL,
    },
    contracts: {
        paymentStream: PAYMENT_STREAM_CONTRACT_ID,
        distributor: DISTRIBUTOR_CONTRACT_ID,
    },
});

function toStreamStatus(status: string): StreamStatus {
    if (status === 'Paused') return StreamStatus.Paused;
    if (status === 'Canceled') return StreamStatus.Canceled;
    if (status === 'Completed') return StreamStatus.Completed;
    return StreamStatus.Active;
}

function mapServiceStream(stream: ServiceStream): Stream {
    return {
        id: Number(stream.id),
        sender: stream.sender,
        recipient: stream.recipient,
        token: stream.token,
        total_amount: stream.totalAmount,
        withdrawn_amount: stream.withdrawnAmount,
        start_time: Number(stream.startTime),
        end_time: Number(stream.endTime),
        status: toStreamStatus(stream.status),
    };
}

function serializeStreamId(value: bigint): string {
    return value.toString();
}

async function signAndSendTx<T>(
    tx: AssembledTransaction<T>,
    signTransaction?: WalletSigner
): Promise<string> {
    if (!signTransaction) {
        throw new Error('Wallet signer is required for contract write operations');
    }

    const result = await tx.signAndSend({
        signTransaction: async (xdr: string) => ({
            signedTxXdr: await signTransaction(xdr),
        }),
    });

    return (result as unknown as { hash: string }).hash;
}

function createPaymentStreamClient(publicKey: string): PaymentStreamClient {
    return new PaymentStreamClient({
        contractId: PAYMENT_STREAM_CONTRACT_ID,
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: SOROBAN_RPC_URL,
        publicKey,
    });
}

function createDistributorClient(publicKey: string): DistributorClient {
    return new DistributorClient({
        contractId: DISTRIBUTOR_CONTRACT_ID,
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: SOROBAN_RPC_URL,
        publicKey,
    });
}

export async function fetchStream(streamId: number, signal?: AbortSignal): Promise<Stream | null> {
    throwIfAborted(signal);
    const stream = await stellarService.getStream(BigInt(streamId));
    throwIfAborted(signal);
    return stream ? mapServiceStream(stream) : null;
}

export async function fetchUserStreams(address: string, signal?: AbortSignal): Promise<Stream[]> {
    throwIfAborted(signal);
    const streams = await stellarService.getStreams(address);
    throwIfAborted(signal);
    return streams.map(mapServiceStream);
}

export async function createStream(params: {
    sender: string;
    recipient: string;
    token: string;
    amount: bigint;
    startTime: number;
    endTime: number;
    signTransaction?: WalletSigner;
    idempotencyKey?: string | null;
}): Promise<string> {
    const run = async (): Promise<string> => {
        const client = createPaymentStreamClient(params.sender);
        const tx = await client.createStream({
            sender: params.sender,
            recipient: params.recipient,
            token: params.token,
            total_amount: params.amount,
            initial_amount: 0n,
            start_time: BigInt(params.startTime),
            end_time: BigInt(params.endTime),
        });

        await signAndSendTx(tx, params.signTransaction);

        const streamId = extractBigInt(tx.result) ?? extractStreamIdFromTxEvents(tx);
        if (streamId === undefined) {
            throw new Error('Contract did not return a valid stream id');
        }
        return serializeStreamId(streamId);
    };

    if (!params.idempotencyKey) return run();

    const { result } = await withIdempotency(
        {
            key: params.idempotencyKey,
            actor: params.sender,
            operation: 'createStream',
            payload: {
                sender: params.sender,
                recipient: params.recipient,
                token: params.token,
                amount: params.amount.toString(),
                startTime: params.startTime,
                endTime: params.endTime,
            },
        },
        run
    );
    return result;
}

export async function withdraw(params: {
    streamId: number;
    amount: bigint;
    sender?: string;
    signTransaction?: WalletSigner;
    idempotencyKey?: string | null;
}): Promise<string> {
    let sender = params.sender;
    if (!sender) {
        const stream = await stellarService.getStream(BigInt(params.streamId));
        sender = stream?.recipient;
    }

    if (!sender) {
        throw new Error('Unable to resolve sender address for withdrawal');
    }

    const actor = sender;
    const run = async (): Promise<string> => {
        const client = createPaymentStreamClient(actor);
        const tx = await client.withdraw(BigInt(params.streamId), params.amount);
        return signAndSendTx(tx, params.signTransaction);
    };

    if (!params.idempotencyKey) return run();

    const { result } = await withIdempotency(
        {
            key: params.idempotencyKey,
            actor,
            operation: 'withdraw',
            payload: { streamId: params.streamId, amount: params.amount.toString() },
        },
        run
    );
    return result;
}

export async function distribute(params: {
    sender: string;
    token: string;
    recipients: string[];
    amounts: bigint[] | bigint;
    signTransaction?: WalletSigner;
}): Promise<void> {
    const client = createDistributorClient(params.sender);
    const BATCH_SIZE = 100;

    if (typeof params.amounts === 'bigint') {
        const recipientBatches = createBatches(params.recipients, BATCH_SIZE);
        for (const batch of recipientBatches) {
            const tx = await client.distributeEqual({
                sender: params.sender,
                token: params.token,
                total_amount: params.amounts,
                recipients: batch,
            });
            await signAndSendTx(tx, params.signTransaction);
        }
        return;
    }

    if (params.amounts.length !== params.recipients.length) {
        throw new Error('Recipients and amounts length mismatch');
    }

    const recipientBatches = createBatches(params.recipients, BATCH_SIZE);
    const amountBatches = createBatches(params.amounts, BATCH_SIZE);

    for (let i = 0; i < recipientBatches.length; i++) {
        const tx = await client.distributeWeighted({
            sender: params.sender,
            token: params.token,
            recipients: recipientBatches[i],
            amounts: amountBatches[i],
        });
        await signAndSendTx(tx, params.signTransaction);
    }
}

export async function fetchAccountInfo(address: string, signal?: AbortSignal): Promise<AccountInfo | null> {
    throwIfAborted(signal);
    try {
        return await stellarService.getAccount(address, signal);
    } catch {
        return null;
    }
}
export async function pauseStream(params: { id: string; address: string; signTransaction: (xdr: string) => Promise<string> }) {
    const client = new PaymentStreamClient({
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: SOROBAN_RPC_URL,
        contractId: PAYMENT_STREAM_CONTRACT_ID,
        publicKey: params.address,
    });

    const tx = await client.pauseStream(BigInt(params.id));

    await signAndSendTx(tx, params.signTransaction);
}

export async function resumeStream(params: { id: string; address: string; signTransaction: (xdr: string) => Promise<string> }) {
    const client = new PaymentStreamClient({
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: SOROBAN_RPC_URL,
        contractId: PAYMENT_STREAM_CONTRACT_ID,
        publicKey: params.address,
    });

    const tx = await client.resumeStream(BigInt(params.id));

    await signAndSendTx(tx, params.signTransaction);
}

export async function depositToStream(params: {
    streamId: number;
    amount: bigint;
    sender: string;
    signTransaction?: WalletSigner;
    idempotencyKey?: string | null;
}): Promise<string> {
    const run = async (): Promise<string> => {
        const client = createPaymentStreamClient(params.sender);
        const tx = await client.deposit(BigInt(params.streamId), params.amount);
        return signAndSendTx(tx, params.signTransaction);
    };

    if (!params.idempotencyKey) return run();

    const { result } = await withIdempotency(
        {
            key: params.idempotencyKey,
            actor: params.sender,
            operation: 'depositToStream',
            payload: { streamId: params.streamId, amount: params.amount.toString() },
        },
        run
    );
    return result;
}

export async function getWithdrawableAmount(params: {
    streamId: number;
}): Promise<string> {
    const amount = await stellarService.getWithdrawableAmount(BigInt(params.streamId));
    return amount.toString();
}

export async function cancelStream(params: { id: string; address: string; signTransaction: (xdr: string) => Promise<string> }) {
    const client = new PaymentStreamClient({
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: SOROBAN_RPC_URL,
        contractId: PAYMENT_STREAM_CONTRACT_ID,
        publicKey: params.address,
    });

    const tx = await client.cancelStream(BigInt(params.id));

    await signAndSendTx(tx, params.signTransaction);
}

export async function submitFailureProof(params: {
    streamId: number;
    address: string;
    evidence: string;
    signTransaction?: WalletSigner;
    idempotencyKey?: string | null;
}): Promise<string> {
    const run = async (): Promise<string> => {
        const client = createPaymentStreamClient(params.address);
        const tx = await client.submitFailureProof(BigInt(params.streamId), params.evidence);
        return signAndSendTx(tx, params.signTransaction);
    };

    if (!params.idempotencyKey) return run();

    const { result } = await withIdempotency(
        {
            key: params.idempotencyKey,
            actor: params.address,
            operation: 'submitFailureProof',
            payload: { streamId: params.streamId, evidence: params.evidence },
        },
        run
    );
    return result;
}
