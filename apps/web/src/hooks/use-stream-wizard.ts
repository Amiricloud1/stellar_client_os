"use client";

import { useCallback, useMemo, useState } from "react";
import {
  WIZARD_STEPS,
  createInitialWizardData,
  validateWizardStep,
  type WizardErrors,
  type WizardStreamData,
} from "@/components/modules/payment-stream/wizard/wizard-config";
import {
  classifyWalletError,
  type WalletErrorAction,
  type WalletErrorRecovery,
} from "@/lib/wallet/error-classifier";

interface UseStreamWizardOptions {
  defaultToken: string;
  defaultDurationUnit: string;
  /** Optional recovery hooks wired to the connected wallet/RPC layer. */
  onRetry?: () => void | Promise<void>;
  onSwitchNetwork?: (chainId?: number) => void | Promise<void>;
  onReconnect?: () => void | Promise<void>;
}

export function useStreamWizard({
  defaultToken,
  defaultDurationUnit,
  onRetry,
  onSwitchNetwork,
  onReconnect,
}: UseStreamWizardOptions) {
  const initialData = useMemo(
    () => createInitialWizardData(defaultToken, defaultDurationUnit),
    [defaultToken, defaultDurationUnit]
  );

  const [stepIndex, setStepIndex] = useState(0);
  const [data, setData] = useState<WizardStreamData>(initialData);
  const [errors, setErrors] = useState<WizardErrors>({});
  const [recovery, setRecovery] = useState<WalletErrorRecovery | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);

  const currentStep = WIZARD_STEPS[stepIndex];
  const isFirstStep = stepIndex === 0;
  const isLastStep = stepIndex === WIZARD_STEPS.length - 1;

  const updateField = useCallback(
    <K extends keyof WizardStreamData>(key: K, value: WizardStreamData[K]) => {
      setData((prev) => ({ ...prev, [key]: value }));
      // Clear the field error as soon as the creator edits it — stale errors on a
      // field being actively corrected read as broken validation.
      setErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    []
  );

  const validateCurrentStep = useCallback(() => {
    const stepErrors = validateWizardStep(currentStep.id, data);
    setErrors(stepErrors);
    return Object.keys(stepErrors).length === 0;
  }, [currentStep.id, data]);

  const goNext = useCallback(() => {
    if (!validateCurrentStep()) return false;

    setStepIndex((prev) => Math.min(prev + 1, WIZARD_STEPS.length - 1));
    return true;
  }, [validateCurrentStep]);

  const goBack = useCallback(() => {
    setErrors({});
    setStepIndex((prev) => Math.max(prev - 1, 0));
  }, []);

  const goToStep = useCallback(
    (index: number) => {
      // Only steps already reached are navigable, so a creator can revise an
      // earlier answer without skipping validation of steps ahead.
      if (index < 0 || index > stepIndex) return;
      setErrors({});
      setStepIndex(index);
    },
    [stepIndex]
  );

  const reset = useCallback(() => {
    setData(initialData);
    setErrors({});
    setRecovery(null);
    setStepIndex(0);
  }, [initialData]);

  /**
   * Classify a wallet/RPC/simulation/contract failure into a safe recovery
   * action. Form values are intentionally left untouched so the creator can
   * retry without re-entering their stream configuration.
   */
  const reportError = useCallback((error: unknown) => {
    const classified = classifyWalletError(error);
    setRecovery(classified);
    return classified;
  }, []);

  const clearRecovery = useCallback(() => {
    setRecovery(null);
  }, []);

  const runRecovery = useCallback(
    async (action?: WalletErrorAction) => {
      const target = action ?? recovery?.action;
      if (!target) return false;

      setIsRecovering(true);
      try {
        switch (target) {
          case "retry":
            await onRetry?.();
            break;
          case "switch-network":
            await onSwitchNetwork?.(recovery?.chainId);
            break;
          case "reconnect":
            await onReconnect?.();
            break;
          default:
            // Non-recoverable actions (e.g. "contact-support") leave the
            // recovery state in place for the UI to surface guidance.
            return false;
        }
        setRecovery(null);
        return true;
      } finally {
        setIsRecovering(false);
      }
    },
    [recovery, onRetry, onSwitchNetwork, onReconnect]
  );

  const isDirty = useMemo(
    () => JSON.stringify(data) !== JSON.stringify(initialData),
    [data, initialData]
  );

  return {
    steps: WIZARD_STEPS,
    stepIndex,
    currentStep,
    isFirstStep,
    isLastStep,
    data,
    errors,
    isDirty,
    recovery,
    isRecovering,
    setData,
    updateField,
    validateCurrentStep,
    goNext,
    goBack,
    goToStep,
    reset,
    reportError,
    clearRecovery,
    runRecovery,
  };
}

export type StreamWizardState = ReturnType<typeof useStreamWizard>;
