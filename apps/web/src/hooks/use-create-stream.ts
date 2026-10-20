import { QueryClient, QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { createStream } from '@/lib/api';
import { useWallet } from '@/providers/StellarWalletProvider';
import {
    classifyWalletError,
    getWalletErrorRecovery,
    type WalletErrorRecovery,
} from '@/lib/wallet-errors';

type CreateStreamInput = Omit<Parameters<typeof createStream>[0], 'sender' | 'signTransaction'> & {
    sender?: string;
};

interface CreateStreamMutationContext {
    previousStreams: Array<[QueryKey, unknown]>;
    recovery: WalletErrorRecovery;
}

export interface CreateStreamErrorState {
    message: string;
    recovery: WalletErrorRecovery;
    /** The input that failed, preserved so the form can be repopulated on retry. */
    input: CreateStreamInput;
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

export function useCreateStream() {
    const queryClient = useQueryClient();
    const { address, signTransaction } = useWallet();

    return useMutation<Awaited<ReturnType<typeof createStream>>, unknown, CreateStreamInput, CreateStreamMutationContext>({
        mutationFn: (params: CreateStreamInput) => {
            const sender = params.sender || address;
            if (!sender) {
                throw new Error('Wallet not connected');
            }

            return createStream({
                ...params,
                sender,
                signTransaction,
            });
        },
        onMutate: async (newStream): Promise<CreateStreamMutationContext> => {
            const previousStreams = queryClient.getQueriesData({
                queryKey: ['streams'],
            });

            try {
                await queryClient.cancelQueries({ queryKey: ['streams'] });

                queryClient.setQueriesData({ queryKey: ['streams'] }, (old: unknown) => {
                    if (!Array.isArray(old)) {
                        return old;
                    }
                    return [...old, { ...newStream, id: -1, status: 'Active' }];
                });
            } catch {
                // Silently fail optimistic update
            }

            return {
                previousStreams,
                recovery: getWalletErrorRecovery(classifyWalletError(undefined)),
            };
        },
        onError: (error, newStream, context) => {
            const restored = restorePreviousStreams(queryClient, context?.previousStreams);
            if (!restored) {
                queryClient.invalidateQueries({ queryKey: ['streams'] });
            }

            const recovery = getWalletErrorRecovery(classifyWalletError(error));
            const errorState: CreateStreamErrorState = {
                message: recovery.message,
                recovery,
                input: newStream,
            };

            // Preserve the failed input so callers can repopulate the form and retry.
            queryClient.setQueryData(['create-stream', 'error'], errorState);

            toast.error(recovery.message);
        },
        onSettled: (_data, error) => {
            if (!error) {
                queryClient.removeQueries({ queryKey: ['create-stream', 'error'] });
            }
            queryClient.invalidateQueries({ queryKey: ['streams'] });
        },
    });
}
