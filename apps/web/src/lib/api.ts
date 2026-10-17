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
import {
    requirePolicy,
    type ApiRequestContext,
} from './api-policy';
import {
    validateStreamId,
    validateAddress,
    validateCreateStreamInput,
    validateWithdrawInput,
    validateDistributeInput,
    validateDepositInput,
    validateFailureProofInput,
    validateStreamActionInput,
} from './api-schemas';

// NOTE: This module is the single entry point for API-side validation and
// authorization. Every exported function validates its inputs with the shared
// schemas in `api-schemas` before touching services/contracts, and privileged
// operations call `requirePolicy(request, 'privileged')` from `api-policy`.
// Do not bypass these helpers by calling the SDK clients directly from routes.

type WalletSigner = (xdr: string) => Promise<string>;

/**
 * Optional request context threaded through API calls. When omitted, calls are
 * treated as unauthenticated and privileged operations will be rejected.
 */
export type ApiCallContext = ApiRequestContext | undefined;

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

export async function createStream(params: {
    sender: string;
    recipient: string;
    token: string;
    amount: bigint;
    startTime: number;
    endTime: number;
    signTransaction?: WalletSigner;
    request?: ApiCallContext;
}): Promise<string> {
    const input = validateCreateStreamInput(params);
    const client = createPaymentStreamClient(input.sender);
    const tx = await client.createStream({
        sender: input.sender,
        recipient: input.recipient,
        token: input.token,
        total_amount: input.amount,
        initial_amount: 0n,
        start_time: BigInt(input.startTime),
        end_time: BigInt(input.endTime),
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
    request?: ApiCallContext;
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

    const client = createPaymentStreamClient(sender);
    const tx = await client.withdraw(input.streamId, input.amount);
    const hash = await signAndSendTx(tx, params.signTransaction);
    return hash;
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
    request?: ApiCallContext;
}): Promise<string> {
    const input = validateDepositInput(params);
    const client = createPaymentStreamClient(input.sender);
    const tx = await client.deposit(input.streamId, input.amount);
    const hash = await signAndSendTx(tx, params.signTransaction);
    return hash;
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
    request?: ApiCallContext;
}): Promise<string> {
    requirePolicy(params.request, 'privileged');
    const input = validateFailureProofInput(params);
    const client = createPaymentStreamClient(input.address);
    const tx = await client.submitFailureProof(input.streamId, input.evidence);
    const hash = await signAndSendTx(tx, params.signTransaction);
    return hash;
}
