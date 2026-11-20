'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

export interface VersionedDraft<T = unknown> {
  draftId: string;
  version: number;
  updatedAt: number;
  tabId: string;
  data: T;
}

export interface DraftConflict<T = unknown> {
  localVersion: number;
  remoteVersion: number;
  remoteUpdatedAt: number;
  remoteData: T;
}

export interface UseDraftAutosaveOptions<T> {
  draftId: string;
  initialData?: T;
  debounceMs?: number;
  onConflict?: (conflict: DraftConflict<T>) => void;
}

const STORAGE_PREFIX = 'stellar_draft_v1:';

function getTabSessionId(): string {
  if (typeof window === 'undefined') return 'server';
  let tabId = window.sessionStorage.getItem('stellar_tab_id');
  if (!tabId) {
    tabId = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    window.sessionStorage.setItem('stellar_tab_id', tabId);
  }
  return tabId;
}

/**
 * Versioned local autosave hook with stale edit and cross-tab collision detection (Issues #168, #170, #172, #249).
 * Ensures draft recovery never silently overwrites concurrent edits from another tab or collaborator.
 */
export function useDraftAutosave<T>({
  draftId,
  initialData,
  debounceMs = 1500,
  onConflict
}: UseDraftAutosaveOptions<T>) {
  const [data, setData] = useState<T | undefined>(initialData);
  const [version, setVersion] = useState<number>(1);
  const [conflict, setConflict] = useState<DraftConflict<T> | null>(null);
  const [isSaved, setIsSaved] = useState<boolean>(true);
  const currentTabId = useRef<string>('');
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const storageKey = `${STORAGE_PREFIX}${draftId}`;

  useEffect(() => {
    currentTabId.current = getTabSessionId();

    // Check for existing draft on mount
    try {
      const existingRaw = window.localStorage.getItem(storageKey);
      if (existingRaw) {
        const parsed: VersionedDraft<T> = JSON.parse(existingRaw);
        if (parsed && typeof parsed.version === 'number') {
          setData(parsed.data);
          setVersion(parsed.version);
        }
      }
    } catch {
      // LocalStorage access failure handled safely
    }

    // Cross-tab synchronization & collision listener
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key !== storageKey || !e.newValue) return;
      try {
        const incoming: VersionedDraft<T> = JSON.parse(e.newValue);
        if (incoming.tabId !== currentTabId.current && incoming.version > version) {
          const detectedConflict: DraftConflict<T> = {
            localVersion: version,
            remoteVersion: incoming.version,
            remoteUpdatedAt: incoming.updatedAt,
            remoteData: incoming.data
          };
          setConflict(detectedConflict);
          onConflict?.(detectedConflict);
        }
      } catch {
        // Discard malformed storage events
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [storageKey, version, onConflict]);

  const saveDraft = useCallback(
    (newData: T) => {
      setData(newData);
      setIsSaved(false);

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        try {
          const latestRaw = window.localStorage.getItem(storageKey);
          if (latestRaw) {
            const currentStored: VersionedDraft<T> = JSON.parse(latestRaw);
            if (currentStored.tabId !== currentTabId.current && currentStored.version > version) {
              const detectedConflict: DraftConflict<T> = {
                localVersion: version,
                remoteVersion: currentStored.version,
                remoteUpdatedAt: currentStored.updatedAt,
                remoteData: currentStored.data
              };
              setConflict(detectedConflict);
              onConflict?.(detectedConflict);
              return; // Do not overwrite conflicting newer draft
            }
          }

          const nextVersion = version + 1;
          const payload: VersionedDraft<T> = {
            draftId,
            version: nextVersion,
            updatedAt: Date.now(),
            tabId: currentTabId.current,
            data: newData
          };

          window.localStorage.setItem(storageKey, JSON.stringify(payload));
          setVersion(nextVersion);
          setIsSaved(true);
          setConflict(null);
        } catch {
          // Quota exceeded or private browsing
        }
      }, debounceMs);
    },
    [storageKey, draftId, version, debounceMs, onConflict]
  );

  const resolveConflictUsingRemote = useCallback(() => {
    if (conflict) {
      setData(conflict.remoteData);
      setVersion(conflict.remoteVersion);
      setConflict(null);
      setIsSaved(true);
    }
  }, [conflict]);

  const resolveConflictOverwrite = useCallback(
    (currentLocalData: T) => {
      if (conflict) {
        const forceVersion = conflict.remoteVersion + 1;
        const payload: VersionedDraft<T> = {
          draftId,
          version: forceVersion,
          updatedAt: Date.now(),
          tabId: currentTabId.current,
          data: currentLocalData
        };
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(payload));
          setVersion(forceVersion);
          setConflict(null);
          setIsSaved(true);
        } catch {
          // Handled safely
        }
      }
    },
    [conflict, draftId, storageKey]
  );

  const discardDraft = useCallback(() => {
    try {
      window.localStorage.removeItem(storageKey);
      setConflict(null);
      setIsSaved(true);
    } catch {
      // Handled safely
    }
  }, [storageKey]);

  return {
    data,
    saveDraft,
    isSaved,
    conflict,
    resolveConflictUsingRemote,
    resolveConflictOverwrite,
    discardDraft
  };
}
