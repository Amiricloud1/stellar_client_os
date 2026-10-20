import { useState, useEffect, useCallback } from 'react';
import { CampaignCompletionNFT, SponsorPersonalImpactNFT } from '@/types/impact-nft';
import {
  classifyWalletError,
  type WalletErrorAction,
  type WalletErrorInfo,
} from '@/lib/wallet/errorClassifier';

export interface UseCampaignImpactNFTReturn {
  completionNFT: CampaignCompletionNFT | null;
  personalImpactNFT: SponsorPersonalImpactNFT | null;
  isLoading: boolean;
  isMintingCompletion: boolean;
  isMintingPersonal: boolean;
  error: string | null;
  /** Structured classification of the last failure, if any. */
  errorInfo: WalletErrorInfo | null;
  /** Suggested safe recovery action for the last failure. */
  errorAction: WalletErrorAction | null;
  /** Form values preserved across failures so retries can reuse them. */
  formValues: { sponsorAddress: string | null };
  mintCompletionNFT: () => Promise<CampaignCompletionNFT | null>;
  mintPersonalImpactNFT: (addressOverride?: string) => Promise<SponsorPersonalImpactNFT | null>;
  refetch: () => Promise<void>;
  /** Retry the last failed operation using preserved form values. */
  retry: () => Promise<void>;
  /** Clear the current error state without discarding form values. */
  clearError: () => void;
}

type LastOperation =
  | { kind: 'fetch' }
  | { kind: 'mintCompletion' }
  | { kind: 'mintPersonal'; address: string };
=======

export function useCampaignImpactNFT(
  campaignId: string,
  sponsorAddress?: string
): UseCampaignImpactNFTReturn {
  const [completionNFT, setCompletionNFT] = useState<CampaignCompletionNFT | null>(null);
  const [personalImpactNFT, setPersonalImpactNFT] = useState<SponsorPersonalImpactNFT | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isMintingCompletion, setIsMintingCompletion] = useState<boolean>(false);
  const [isMintingPersonal, setIsMintingPersonal] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [errorInfo, setErrorInfo] = useState<WalletErrorInfo | null>(null);
  const [formValues, setFormValues] = useState<{ sponsorAddress: string | null }>({
    sponsorAddress: sponsorAddress ?? null,
  });
  const [lastOperation, setLastOperation] = useState<LastOperation | null>(null);

  const applyError = useCallback((err: unknown, fallbackMessage: string) => {
    const info = classifyWalletError(err, fallbackMessage);
    setError(info.message);
    setErrorInfo(info);
    return info;
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setErrorInfo(null);
  }, []);

  useEffect(() => {
    setFormValues((prev) => ({ ...prev, sponsorAddress: sponsorAddress ?? prev.sponsorAddress }));
  }, [sponsorAddress]);

  const fetchNFTs = useCallback(async () => {
    if (!campaignId) return;
    setLastOperation({ kind: 'fetch' });
    setIsLoading(true);
    clearError();

    try {
      // 1. Fetch Completion NFT
      const compRes = await fetch(`/api/campaigns/${campaignId}/completion-nft`);
      if (compRes.ok) {
        const compData = await compRes.json();
        if (compData.success && compData.nft) {
          setCompletionNFT(compData.nft);
        }
      } else if (compRes.status !== 404) {
        const errData = await compRes.json().catch(() => ({}));
        console.warn('Failed to fetch completion NFT:', errData.error);
      }

      // 2. Fetch Personal Impact NFT if sponsorAddress provided
      if (sponsorAddress) {
        const persRes = await fetch(
          `/api/campaigns/${campaignId}/personal-impact-nft?sponsorAddress=${encodeURIComponent(sponsorAddress)}`
        );
        if (persRes.ok) {
          const persData = await persRes.json();
          if (persData.success && persData.nft) {
            setPersonalImpactNFT(persData.nft);
          }
        }
      }
    } catch (err: unknown) {
      applyError(err, 'Error fetching impact NFTs');
    } finally {
      setIsLoading(false);
    }
  }, [campaignId, sponsorAddress, applyError, clearError]);

  useEffect(() => {
    void fetchNFTs();
  }, [fetchNFTs]);

  const mintCompletionNFT = async (): Promise<CampaignCompletionNFT | null> => {
    setLastOperation({ kind: 'mintCompletion' });
    setIsMintingCompletion(true);
    clearError();

    try {
      const res = await fetch(`/api/campaigns/${campaignId}/completion-nft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to mint campaign completion NFT');
      }

      setCompletionNFT(data.nft);
      return data.nft;
    } catch (err: unknown) {
      applyError(err, 'Failed to mint campaign completion NFT');
      return null;
    } finally {
      setIsMintingCompletion(false);
    }
  };

  const mintPersonalImpactNFT = async (addressOverride?: string): Promise<SponsorPersonalImpactNFT | null> => {
    const targetAddress = addressOverride || formValues.sponsorAddress || sponsorAddress;
    if (!targetAddress) {
      applyError(
        { code: 'MISSING_SPONSOR_ADDRESS' },
        'Sponsor address is required to mint personal impact NFT'
      );
      return null;
    }

    setFormValues((prev) => ({ ...prev, sponsorAddress: targetAddress }));
    setLastOperation({ kind: 'mintPersonal', address: targetAddress });
    setIsMintingPersonal(true);
    clearError();

    try {
      const res = await fetch(`/api/campaigns/${campaignId}/personal-impact-nft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sponsorAddress: targetAddress }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to mint personal impact NFT');
      }

      setPersonalImpactNFT(data.nft);
      return data.nft;
    } catch (err: unknown) {
      applyError(err, 'Failed to mint personal impact NFT');
      return null;
    } finally {
      setIsMintingPersonal(false);
    }
  };

  const retry = useCallback(async (): Promise<void> => {
    if (!lastOperation) {
      await fetchNFTs();
      return;
    }

    switch (lastOperation.kind) {
      case 'mintCompletion':
        await mintCompletionNFT();
        break;
      case 'mintPersonal':
        await mintPersonalImpactNFT(lastOperation.address);
        break;
      case 'fetch':
      default:
        await fetchNFTs();
        break;
    }
  }, [lastOperation, fetchNFTs, mintCompletionNFT, mintPersonalImpactNFT]);

  return {
    completionNFT,
    personalImpactNFT,
    isLoading,
    isMintingCompletion,
    isMintingPersonal,
    error,
    errorInfo,
    errorAction: errorInfo?.action ?? null,
    formValues,
    mintCompletionNFT,
    mintPersonalImpactNFT,
    refetch: fetchNFTs,
    retry,
    clearError,
  };
}
