import { QueryClient, QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { distribute } from '@/lib/api';
import { useWallet } from '@/providers/StellarWalletProvider';
import {
    classifyWalletError,
    type WalletErrorAction,
} from '@/lib/wallet-error-classifier';
import { createBatches } from '../../../../packages/sdk/src/utils/batchDistribution';

type DistributeInput = Parameters<typeof distribute>[0];

interface DistributeMutationContext {
    previousStreams: Array<[QueryKey, unknown]>;
    /** Snapshot of the submitted form values so the form can be restored on failure. */
    formValues: DistributeInput;
    /** Classified failure action, populated in onError for consumers (e.g. retry UI). */
    errorAction?: WalletErrorAction;
}

function isChainChangedError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === 'CHAIN_CHANGED'
    );
}

function restorePreviousStreams(
    queryClient: QueryClient,
    previousStreams: Array<[QueryKey, unknown]> | undefined
): boolean {
    if (!previousStreams?.length) {
        return false;
    }

    previousStreams.forEach(([queryKey, data]) => {
        queryClient.setQueryData(queryKey, data);
    });

    return true;
}

export function useDistribute() {
    const queryClient = useQueryClient();
    const { address, signTransaction } = useWallet();
    const { assertChainUnchanged, beginFlow } = useChainGuard();

    return useMutation({
        mutationFn: async (params: DistributeInput) => {
            const sender = params.sender || address;
            if (!sender) {
                throw new Error('Wallet not connected');
            }

            // Bind the whole (possibly batched) flow to the chain identity at start.
            const flow = beginFlow();

            const runBatch = async (batchParams: DistributeInput) => {
                assertChainUnchanged(flow);
                const result = await distribute({
                    ...batchParams,
                    sender,
                    signTransaction,
                });
                assertChainUnchanged(flow);
                return result;
            };

            const BATCH_SIZE = 100;
            if (params.recipients.length > BATCH_SIZE) {
                const recipientBatches = createBatches(params.recipients, BATCH_SIZE);
                if (typeof params.amounts === 'bigint') {
                    for (const batch of recipientBatches) {
                        await runBatch({
                            ...params,
                            recipients: batch,
                            sender,
                            signTransaction,
                        });
                    }
                    return;
                } else {
                    const amountBatches = createBatches(params.amounts, BATCH_SIZE);
                    for (let i = 0; i < recipientBatches.length; i++) {
                        await runBatch({
                            ...params,
                            recipients: recipientBatches[i],
                            amounts: amountBatches[i],
                            sender,
                            signTransaction,
                        });
                    }
                    return;
                }
            }

            return runBatch({
                ...params,
                sender,
                signTransaction,
            });
        },
        onMutate: async (variables: DistributeInput): Promise<DistributeMutationContext> => {
            const previousStreams = queryClient.getQueriesData({
                queryKey: ['streams'],
            });

            try {
                await queryClient.cancelQueries({ queryKey: ['streams'] });
            } catch {
                // Silently fail cache snapshot
            }

            return { previousStreams, formValues: variables };
        },
        onError: (error, _variables, context) => {
            const restored = restorePreviousStreams(queryClient, context?.previousStreams);
            if (!restored) {
                queryClient.invalidateQueries({ queryKey: ['streams'] });
            }

            const action = classifyWalletError(error);
            if (context) {
                context.errorAction = action;
            }

            switch (action.kind) {
                case 'wallet_disconnected':
                    toast.error('Wallet disconnected. Reconnect your wallet and retry.');
                    break;
                case 'wrong_network':
                    toast.error('Wrong network selected. Switch networks and retry.');
                    break;
                case 'user_rejected':
                    toast.error('Transaction rejected in wallet. Your form values were kept.');
                    break;
                case 'insufficient_funds':
                    toast.error('Insufficient funds. Adjust the amounts and retry.');
                    break;
                case 'simulation_failed':
                    toast.error('Simulation failed. Review the transaction and retry.');
                    break;
                default:
                    toast.error('Distribution failed. Refreshing latest data.');
                    break;
            }
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['streams'] });
        },
    });
}

export type { DistributeMutationContext };
