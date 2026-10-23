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
import {
    DEFAULT_PAGE_LIMIT,
    MAX_PAGE_LIMIT,
    type PageInfo,
    type PaginationInput,
    type SortInput,
} from '../../../../packages/shared/src/pagination';

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
    const id = validateStreamId(streamId);
    throwIfAborted(signal);
    const stream = await stellarService.getStream(id);
    throwIfAborted(signal);
    return stream ? mapServiceStream(stream) : null;
}

export async function fetchUserStreams(address: string, signal?: AbortSignal): Promise<Stream[]> {
    const account = validateAddress(address);
    throwIfAborted(signal);
    const streams = await stellarService.getStreams(account);
    throwIfAborted(signal);
    return streams.map(mapServiceStream);
}

/**
 * Paginated variant of {@link fetchUserStreams}. Sends shared pagination and
 * sort parameters and returns the shared `PageInfo` metadata envelope.
 */
export async function fetchUserStreamsPage(
    address: string,
    pagination?: PaginationInput,
    sort?: SortInput,
    signal?: AbortSignal
): Promise<PaginatedResponse<Stream>> {
    const page = await fetchPaginated<ServiceStream>(
        `/api/streams/${encodeURIComponent(address)}`,
        pagination,
        sort,
        signal
    );
    return { items: page.items.map(mapServiceStream), pageInfo: page.pageInfo };
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
    const input = validateWithdrawInput(params);
    let sender = input.sender;
    if (!sender) {
        const stream = await stellarService.getStream(input.streamId);
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
    request?: ApiCallContext;
}): Promise<void> {
    requirePolicy(params.request, 'privileged');
    const input = validateDistributeInput(params);
    const client = createDistributorClient(input.sender);
    const BATCH_SIZE = 100;

    if (typeof input.amounts === 'bigint') {
        const recipientBatches = createBatches(input.recipients, BATCH_SIZE);
        for (const batch of recipientBatches) {
            const tx = await client.distributeEqual({
                sender: input.sender,
                token: input.token,
                total_amount: input.amounts,
                recipients: batch,
            });
            await signAndSendTx(tx, params.signTransaction);
        }
        return;
    }

    const recipientBatches = createBatches(input.recipients, BATCH_SIZE);
    const amountBatches = createBatches(input.amounts, BATCH_SIZE);

    for (let i = 0; i < recipientBatches.length; i++) {
        const tx = await client.distributeWeighted({
            sender: input.sender,
            token: input.token,
            recipients: recipientBatches[i],
            amounts: amountBatches[i],
        });
        await signAndSendTx(tx, params.signTransaction);
    }
}

export async function fetchAccountInfo(address: string, signal?: AbortSignal): Promise<AccountInfo | null> {
    const account = validateAddress(address);
    throwIfAborted(signal);
    try {
        return await stellarService.getAccount(account, signal);
    } catch {
        return null;
    }
}
export async function pauseStream(params: {
    id: string;
    address: string;
    signTransaction: (xdr: string) => Promise<string>;
    request?: ApiCallContext;
}) {
    requirePolicy(params.request, 'privileged');
    const input = validateStreamActionInput(params);
    const client = new PaymentStreamClient({
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: SOROBAN_RPC_URL,
        contractId: PAYMENT_STREAM_CONTRACT_ID,
        publicKey: input.address,
    });

    const tx = await client.pauseStream(input.id);

    await signAndSendTx(tx, params.signTransaction);
}

export async function resumeStream(params: {
    id: string;
    address: string;
    signTransaction: (xdr: string) => Promise<string>;
    request?: ApiCallContext;
}) {
    requirePolicy(params.request, 'privileged');
    const input = validateStreamActionInput(params);
    const client = new PaymentStreamClient({
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: SOROBAN_RPC_URL,
        contractId: PAYMENT_STREAM_CONTRACT_ID,
        publicKey: input.address,
    });

    const tx = await client.resumeStream(input.id);

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
    const streamId = validateStreamId(params.streamId);
    const amount = await stellarService.getWithdrawableAmount(streamId);
    return amount.toString();
}

export async function cancelStream(params: {
    id: string;
    address: string;
    signTransaction: (xdr: string) => Promise<string>;
    request?: ApiCallContext;
}) {
    requirePolicy(params.request, 'privileged');
    const input = validateStreamActionInput(params);
    const client = new PaymentStreamClient({
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: SOROBAN_RPC_URL,
        contractId: PAYMENT_STREAM_CONTRACT_ID,
        publicKey: input.address,
    });

    const tx = await client.cancelStream(input.id);

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

/**
 * Stable error codes returned by {@link requestUploadPresign}. Callers (and the
 * HTTP layer) should map these to status codes without inspecting messages.
 */
export const UPLOAD_PRESIGN_ERROR_CODES = {
    UNAUTHORIZED: 'UPLOAD_PRESIGN_UNAUTHORIZED',
    UNSUPPORTED_TYPE: 'UPLOAD_PRESIGN_UNSUPPORTED_TYPE',
    PAYLOAD_TOO_LARGE: 'UPLOAD_PRESIGN_PAYLOAD_TOO_LARGE',
    INVALID_KEY: 'UPLOAD_PRESIGN_INVALID_KEY',
    TAMPERED_REQUEST: 'UPLOAD_PRESIGN_TAMPERED_REQUEST',
} as const;

export type UploadPresignErrorCode =
    (typeof UPLOAD_PRESIGN_ERROR_CODES)[keyof typeof UPLOAD_PRESIGN_ERROR_CODES];

export class UploadPresignError extends Error {
    readonly code: UploadPresignErrorCode;

    constructor(code: UploadPresignErrorCode, message: string) {
        super(message);
        this.name = 'UploadPresignError';
        this.code = code;
    }
}

/** Allowed MIME types for campaign/milestone evidence uploads. */
export const ALLOWED_UPLOAD_MIME_TYPES = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/pdf',
] as const;

export type AllowedUploadMimeType = (typeof ALLOWED_UPLOAD_MIME_TYPES)[number];

/** Hard upper bound on a single uploaded object, in bytes (10 MiB). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Presigned URLs are short-lived; expiry is bounded to this window (seconds). */
export const MAX_UPLOAD_PRESIGN_EXPIRY_SECONDS = 15 * 60;

export type UploadScope = 'campaign' | 'milestone';

export interface UploadPresignRequest {
    /** Wallet address of the caller requesting the presign. */
    requester: string;
    /** Campaign the upload belongs to. */
    campaignId: string;
    /** Milestone the upload belongs to (required for milestone scope). */
    milestoneId?: string;
    /** Declared MIME type of the object to upload. */
    contentType: string;
    /** Declared size of the object to upload, in bytes. */
    contentLength: number;
    /** Original file name; used only to derive a safe extension. */
    fileName: string;
    /** Requested expiry in seconds; clamped to {@link MAX_UPLOAD_PRESIGN_EXPIRY_SECONDS}. */
    expiresInSeconds?: number;
}

export interface UploadPresignResult {
    /** Safe, server-derived object key. Never trust a client-supplied key. */
    key: string;
    /** Bounded expiry actually applied, in seconds. */
    expiresInSeconds: number;
    /** Declared content type that was validated. */
    contentType: AllowedUploadMimeType;
}

export interface UploadPresignDeps {
    /** Resolves the owner (wallet address) of a campaign, or null if unknown. */
    getCampaignOwner: (campaignId: string) => Promise<string | null>;
    /** Resolves the campaign a milestone belongs to, or null if unknown. */
    getMilestoneCampaign: (milestoneId: string) => Promise<string | null>;
}

const SAFE_KEY_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const EXTENSION_BY_MIME: Record<AllowedUploadMimeType, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
};

function assertSafeSegment(value: string, field: string): void {
    if (!SAFE_KEY_SEGMENT.test(value)) {
        throw new UploadPresignError(
            UPLOAD_PRESIGN_ERROR_CODES.INVALID_KEY,
            `Invalid ${field}: must match ${SAFE_KEY_SEGMENT}`
        );
    }
}

/**
 * Builds a deterministic, traversal-safe object key. The key is derived
 * entirely from validated server-side values; the client-supplied file name is
 * never embedded (only its MIME type determines the extension).
 */
export function buildUploadKey(params: {
    scope: UploadScope;
    campaignId: string;
    milestoneId?: string;
    contentType: AllowedUploadMimeType;
}): string {
    assertSafeSegment(params.campaignId, 'campaignId');
    if (params.scope === 'milestone') {
        if (!params.milestoneId) {
            throw new UploadPresignError(
                UPLOAD_PRESIGN_ERROR_CODES.INVALID_KEY,
                'milestoneId is required for milestone scope'
            );
        }
        assertSafeSegment(params.milestoneId, 'milestoneId');
        return `campaigns/${params.campaignId}/milestones/${params.milestoneId}/evidence.${EXTENSION_BY_MIME[params.contentType]}`;
    }
    return `campaigns/${params.campaignId}/evidence.${EXTENSION_BY_MIME[params.contentType]}`;
}

function isAllowedMimeType(value: string): value is AllowedUploadMimeType {
    return (ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Validates an upload presign request and returns the bound, safe key and
 * bounded expiry. Throws {@link UploadPresignError} with a stable code for
 * unauthorized, tampered, or out-of-policy requests.
 */
export async function requestUploadPresign(
    request: UploadPresignRequest,
    deps: UploadPresignDeps
): Promise<UploadPresignResult> {
    if (!request.requester) {
        throw new UploadPresignError(
            UPLOAD_PRESIGN_ERROR_CODES.UNAUTHORIZED,
            'Requester address is required'
        );
    }

    // Ownership: the caller must own the campaign (and the milestone must
    // belong to that same campaign).
    const campaignOwner = await deps.getCampaignOwner(request.campaignId);
    if (!campaignOwner || campaignOwner !== request.requester) {
        throw new UploadPresignError(
            UPLOAD_PRESIGN_ERROR_CODES.UNAUTHORIZED,
            'Requester does not own the target campaign'
        );
    }

    const scope: UploadScope = request.milestoneId ? 'milestone' : 'campaign';
    if (scope === 'milestone') {
        const milestoneCampaign = await deps.getMilestoneCampaign(request.milestoneId as string);
        if (milestoneCampaign !== request.campaignId) {
            throw new UploadPresignError(
                UPLOAD_PRESIGN_ERROR_CODES.TAMPERED_REQUEST,
                'Milestone does not belong to the target campaign'
            );
        }
    }

    // Content type: must be an exact, allow-listed MIME type.
    if (!isAllowedMimeType(request.contentType)) {
        throw new UploadPresignError(
            UPLOAD_PRESIGN_ERROR_CODES.UNSUPPORTED_TYPE,
            `Unsupported content type: ${request.contentType}`
        );
    }

    // Size: must be a positive integer within the hard limit.
    if (
        !Number.isInteger(request.contentLength) ||
        request.contentLength <= 0 ||
        request.contentLength > MAX_UPLOAD_BYTES
    ) {
        throw new UploadPresignError(
            UPLOAD_PRESIGN_ERROR_CODES.PAYLOAD_TOO_LARGE,
            `contentLength must be an integer in (0, ${MAX_UPLOAD_BYTES}]`
        );
    }

    // Derive the key server-side; reject any attempt to smuggle a path.
    if (request.fileName.includes('/') || request.fileName.includes('\\') || request.fileName.includes('..')) {
        throw new UploadPresignError(
            UPLOAD_PRESIGN_ERROR_CODES.INVALID_KEY,
            'fileName must not contain path separators or traversal sequences'
        );
    }

    const key = buildUploadKey({
        scope,
        campaignId: request.campaignId,
        milestoneId: request.milestoneId,
        contentType: request.contentType,
    });

    const requested = request.expiresInSeconds ?? MAX_UPLOAD_PRESIGN_EXPIRY_SECONDS;
    if (!Number.isFinite(requested) || requested <= 0) {
        throw new UploadPresignError(
            UPLOAD_PRESIGN_ERROR_CODES.TAMPERED_REQUEST,
            'expiresInSeconds must be a positive number'
        );
    }
    const expiresInSeconds = Math.min(Math.floor(requested), MAX_UPLOAD_PRESIGN_EXPIRY_SECONDS);

    return { key, expiresInSeconds, contentType: request.contentType };
}
