import { useCallback, useRef, useState } from 'react';
import { extractExif, ExifSizeError, ExifTypeError, type ExifSummary } from '@/lib/exif';

export type ExifPreviewStatus = 'idle' | 'loading' | 'success' | 'error';

export function useExifPreview() {
  const [status, setStatus] = useState<ExifPreviewStatus>('idle');
  const [data, setData] = useState<ExifSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Cancellation: track the current file so a stale async result from a
  // previously selected file is discarded if a new file is chosen.
  const currentFileRef = useRef<File | null>(null);

  const analyze = useCallback(async (file: File) => {
    // Register this file as the current in-flight request
    currentFileRef.current = file;

    setStatus('loading');
    setData(null);
    setError(null);

    try {
      const result = await extractExif(file, { redactGps: true });

      // Discard stale results if a newer file was selected while parsing
      if (currentFileRef.current !== file) return;

      setData(result);
      setStatus('success');
    } catch (err) {
      // Discard stale errors too
      if (currentFileRef.current !== file) return;

      if (err instanceof ExifSizeError) {
        setError('The selected file is too large (maximum 20 MB).');
      } else if (err instanceof ExifTypeError) {
        setError('This file type is not supported. Please use JPEG, PNG, WebP, or HEIC.');
      } else {
        setError('Could not read file metadata.');
      }
      setStatus('error');
    }
  }, []);

  const reset = useCallback(() => {
    currentFileRef.current = null;
    setStatus('idle');
    setData(null);
    setError(null);
  }, []);

  /** Cancel any in-flight analysis without surfacing an error. */
  const cancel = useCallback(() => {
    currentFileRef.current = null;
    setStatus('idle');
    setData(null);
    setError(null);
  }, []);

  return { status, data, error, analyze, reset, cancel };
}
