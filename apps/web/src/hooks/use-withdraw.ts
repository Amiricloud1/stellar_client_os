import { QueryClient, QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { withdraw } from '@/lib/api';
import { useWallet } from '@/providers/StellarWalletProvider';
import {
    classifyWalletError,
    getWalletErrorRecovery,
    type WalletErrorRecovery,
} from '@/lib/wallet-errors';

type WithdrawInput = Parameters<typeof withdraw>[0];

interface WithdrawMutationContext {
    previousStreams: Array<[QueryKey, unknown]>;
    streamQueryKey?: QueryKey;
    previousStream?: unknown;
}

export interface WithdrawErrorState {
    message: string;
    recovery: WalletErrorRecovery;
    /** Form values captured at failure time so the UI can restore them. */
    formValues?: WithdrawInput;
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

export function useWithdraw() {
    const queryClient = useQueryClient();
    const { address, signTransaction } = useWallet();

    return useMutation({
        mutationFn: (params: WithdrawInput) => {
            return withdraw({
                ...params,
                sender: params.sender || address || undefined,
                signTransaction,
            });
        },
        onMutate: async (variables): Promise<WithdrawMutationContext> => {
            const previousStreams = queryClient.getQueriesData({
                queryKey: ['streams'],
            });
            const streamQueryKey: QueryKey | undefined =
                typeof variables?.streamId === 'number' ? ['stream', variables.streamId] : undefined;
            const previousStream = streamQueryKey
                ? queryClient.getQueryData(streamQueryKey)
                : undefined;

            try {
                await queryClient.cancelQueries({ queryKey: ['streams'] });
                if (streamQueryKey) {
                    await queryClient.cancelQueries({ queryKey: streamQueryKey });
                }
            } catch {
                // Silently fail cache snapshot
            }

            return { previousStreams, streamQueryKey, previousStream };
        },
        onError: (error, variables, context) => {
            const restoredStreams = restorePreviousStreams(queryClient, context?.previousStreams);
            let restoredStreamDetails = false;

            if (context?.streamQueryKey && typeof context.previousStream !== 'undefined') {
                queryClient.setQueryData(context.streamQueryKey, context.previousStream);
                restoredStreamDetails = true;
            }

            if (!restoredStreams && !restoredStreamDetails) {
                queryClient.invalidateQueries({ queryKey: ['streams'] });
                if (typeof variables?.streamId === 'number') {
                    queryClient.invalidateQueries({ queryKey: ['stream', variables.streamId] });
                }
            }

            // Classify the failure and surface a safe, actionable message. Form
            // values are preserved via the mutation's `variables` so the caller
            // can repopulate the form without losing user input.
            const classified = classifyWalletError(error);
            const recovery = getWalletErrorRecovery(classified);
            toast.error(recovery.message);
        },
        onSettled: (_data, _error, variables) => {
            queryClient.invalidateQueries({ queryKey: ['streams'] });
            if (typeof variables?.streamId === 'number') {
                queryClient.invalidateQueries({ queryKey: ['stream', variables.streamId] });
            }
        },
    });
}

/**
 * Derive a recoverable error state from a withdraw mutation error, including
 * the form values that should be restored so retries don't lose user input.
 */
export function getWithdrawErrorState(
    error: unknown,
    variables?: WithdrawInput
): WithdrawErrorState {
    const classified = classifyWalletError(error);
    const recovery = getWalletErrorRecovery(classified);
    return {
        message: recovery.message,
        recovery,
        formValues: variables,
    };
}
