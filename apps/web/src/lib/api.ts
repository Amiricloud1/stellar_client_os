import type { AssembledTransaction } from '@stellar/stellar-sdk/contract';
import { AsyncLocalStorage } from 'node:async_hooks';
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
 * Canonical API error contract.
 *
 * Every API response helper returns an {@link ApiEnvelope}. Failures carry a
 * structured {@link ApiError} with a stable machine-readable `code`, a
 * human-readable `message`, the `requestId` used to correlate server logs, and
 * optional per-field validation errors. Stack traces are never serialized.
 */
export type ApiErrorCode =
    | 'VALIDATION_ERROR'
    | 'NOT_FOUND'
    | 'UNAUTHORIZED'
    | 'CONFLICT'
    | 'INTERNAL_ERROR';

export interface ApiFieldError {
    field: string;
    message: string;
}

export interface ApiError {
    code: ApiErrorCode;
    message: string;
    requestId: string;
    fieldErrors?: ApiFieldError[];
}

export interface ApiSuccess<T> {
    ok: true;
    data: T;
    requestId: string;
}

export interface ApiFailure {
    ok: false;
    error: ApiError;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

const REQUEST_ID_HEADER = 'x-request-id';

const requestIdStorage = new AsyncLocalStorage<string>();

let requestIdCounter = 0;

function generateRequestId(): string {
    const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
    requestIdCounter += 1;
    return `req_${Date.now().toString(36)}_${requestIdCounter.toString(36)}`;
}

/**
 * Returns the request ID for the current async context. When called inside
 * {@link withRequestId} the propagated ID is returned; otherwise a fresh ID is
 * generated (and, if a `Request` is supplied, its `x-request-id` header is
 * honored as a fallback).
 */
export function getRequestId(request?: { headers?: { get(name: string): string | null } }): string {
    const stored = requestIdStorage.getStore();
    if (stored) return stored;
    const headerValue = request?.headers?.get(REQUEST_ID_HEADER);
    if (headerValue) return headerValue;
    return generateRequestId();
}

/**
 * Runs `fn` with a request ID bound to the async context so that logs and
 * error envelopes emitted during the call share the same identifier.
 */
export function withRequestId<T>(requestId: string | undefined, fn: () => T): T {
    return requestIdStorage.run(requestId ?? generateRequestId(), fn);
}

export class ApiRequestError extends Error {
    readonly code: ApiErrorCode;
    readonly fieldErrors?: ApiFieldError[];

    constructor(code: ApiErrorCode, message: string, fieldErrors?: ApiFieldError[]) {
        super(message);
        this.name = 'ApiRequestError';
        this.code = code;
        this.fieldErrors = fieldErrors;
    }
}

/**
 * Normalizes any thrown value into a structured {@link ApiError}. Stack traces
 * and other internal details are intentionally excluded from the output.
 */
export function toApiError(error: unknown, requestId: string = getRequestId()): ApiError {
    if (error instanceof ApiRequestError) {
        const apiError: ApiError = {
            code: error.code,
            message: error.message,
            requestId,
        };
        if (error.fieldErrors && error.fieldErrors.length > 0) {
            apiError.fieldErrors = error.fieldErrors.map(({ field, message }) => ({ field, message }));
        }
        return apiError;
    }

    return {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId,
    };
}

export function apiSuccess<T>(data: T, requestId: string = getRequestId()): ApiSuccess<T> {
    return { ok: true, data, requestId };
}

export function apiFailure(error: unknown, requestId: string = getRequestId()): ApiFailure {
    return { ok: false, error: toApiError(error, requestId) };
}

/**
 * Executes `fn` and wraps the outcome in an {@link ApiEnvelope}. Unexpected
 * errors are converted to a generic `INTERNAL_ERROR` without leaking stacks.
 */
export async function runApi<T>(
    fn: () => Promise<T> | T,
    requestId: string = getRequestId()
): Promise<ApiEnvelope<T>> {
    try {
        const data = await fn();
        return apiSuccess(data, requestId);
    } catch (error) {
        return apiFailure(error, requestId);
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
}): Promise<string> {
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
}

export async function withdraw(params: {
    streamId: number;
    amount: bigint;
    sender?: string;
    signTransaction?: WalletSigner;
}): Promise<string> {
    let sender = params.sender;
    if (!sender) {
        const stream = await stellarService.getStream(BigInt(params.streamId));
        sender = stream?.recipient;
    }

    if (!sender) {
        throw new Error('Unable to resolve sender address for withdrawal');
    }

    const client = createPaymentStreamClient(sender);
    const tx = await client.withdraw(BigInt(params.streamId), params.amount);
    const hash = await signAndSendTx(tx, params.signTransaction);
    return hash;
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
}): Promise<string> {
    const client = createPaymentStreamClient(params.sender);
    const tx = await client.deposit(BigInt(params.streamId), params.amount);
    const hash = await signAndSendTx(tx, params.signTransaction);
    return hash;
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
}): Promise<string> {
    const client = createPaymentStreamClient(params.address);
    const tx = await client.submitFailureProof(BigInt(params.streamId), params.evidence);
    const hash = await signAndSendTx(tx, params.signTransaction);
    return hash;
}
