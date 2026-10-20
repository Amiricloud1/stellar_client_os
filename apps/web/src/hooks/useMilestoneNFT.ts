import { useState, useEffect, useCallback } from 'react';
import { getEligibleNFTTier, CampaignProgress, NFTTier } from '@fundable/sdk';
import {
  classifyWalletError,
  WalletErrorClass,
  WalletErrorAction,
  WalletErrorInfo,
} from '../lib/walletErrors';

export interface MilestoneNFTErrorState {
  errorClass: WalletErrorClass;
  action: WalletErrorAction;
  message: string;
}

export interface UseMilestoneNFTOptions {
  /**
   * Optional override for the mint transaction. Defaults to a simulated
   * contract call. Injected in tests to exercise each failure class
   * deterministically without live funds.
   */
  mintTransaction?: (tier: NFTTier, campaign: CampaignProgress) => Promise<void>;
  /** Optional callback invoked when a retryable failure occurs. */
  onRetry?: () => void;
  /** Optional callback invoked when a network switch is required. */
  onSwitchNetwork?: () => void;
  /** Optional callback invoked when a reconnect is required. */
  onReconnect?: () => void;
}

const defaultMintTransaction = async (
  tier: NFTTier,
  campaign: CampaignProgress,
): Promise<void> => {
  console.log(`Preparing to mint ${tier} NFT for campaign ${campaign.campaignId}...`);
  // Simulating contract transaction delay
  await new Promise((resolve) => setTimeout(resolve, 2000));
  console.log(`Successfully minted the ${tier} commemorative NFT!`);
};

export function useMilestoneNFT(
  campaign: CampaignProgress | null,
  options: UseMilestoneNFTOptions = {},
) {
  const [eligibleTier, setEligibleTier] = useState<NFTTier | null>(null);
  const [isMinting, setIsMinting] = useState(false);
  const [error, setError] = useState<MilestoneNFTErrorState | null>(null);

  const {
    mintTransaction = defaultMintTransaction,
    onRetry,
    onSwitchNetwork,
    onReconnect,
  } = options;

  useEffect(() => {
    if (campaign) {
      const tier = getEligibleNFTTier(campaign);
      setEligibleTier(tier);
    }
  }, [campaign]);

  const handleErrorAction = useCallback(
    (info: WalletErrorInfo) => {
      switch (info.action) {
        case 'retry':
          onRetry?.();
          break;
        case 'switch-network':
          onSwitchNetwork?.();
          break;
        case 'reconnect':
          onReconnect?.();
          break;
        case 'none':
        default:
          break;
      }
    },
    [onRetry, onSwitchNetwork, onReconnect],
  );

  const mintNFT = useCallback(async () => {
    if (!eligibleTier || !campaign) return;

    setIsMinting(true);
    setError(null);
    try {
      await mintTransaction(eligibleTier, campaign);
      // Only clear the eligible tier on success so the form/state is
      // preserved on failure and the user can retry.
      setEligibleTier(null);
    } catch (err) {
      const info = classifyWalletError(err);
      setError({
        errorClass: info.errorClass,
        action: info.action,
        message: info.message,
      });
      handleErrorAction(info);
    } finally {
      setIsMinting(false);
    }
  }, [eligibleTier, campaign, mintTransaction, handleErrorAction]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    eligibleTier,
    isMinting,
    error,
    mintNFT,
    clearError,
  };
}