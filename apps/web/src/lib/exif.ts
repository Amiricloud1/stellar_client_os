import exifr from 'exifr';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExifSummary {
  gps: { latitude: number; longitude: number } | null;
  timestamp: string | null;
  device: { make: string | null; model: string | null };
  /** EXIF orientation tag (1–8). Used to correct display rotation. */
  orientation: number | null;
  /** True if GPS data was found in the raw EXIF but stripped for privacy. */
  gpsRedacted: boolean;
}

/** Options for EXIF extraction and sanitization. */
export interface ExifOptions {
  /**
   * When true (default) GPS coordinates are stripped from the summary so
   * they are never sent to the server or shown in the UI.
   * Set to false only when the operator explicitly needs location data.
   */
  redactGps?: boolean;
  /**
   * Maximum file size in bytes.  Files larger than this limit cause
   * extractExif to throw a {@link ExifSizeError}.
   * Default: 20 MB (20 * 1024 * 1024).
   */
  maxFileSizeBytes?: number;
  /**
   * MIME types accepted for EXIF extraction.
   * Default: image/jpeg, image/png, image/webp, image/heic, image/tiff
   */
  allowedMimeTypes?: string[];
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when the file exceeds the maximum allowed size. */
export class ExifSizeError extends Error {
  constructor(fileSize: number, maxSize: number) {
    super(`File size ${fileSize} bytes exceeds maximum ${maxSize} bytes`);
    this.name = 'ExifSizeError';
  }
}

/** Thrown when the MIME type is not in the allowed list. */
export class ExifTypeError extends Error {
  constructor(mimeType: string) {
    super(`File type "${mimeType}" is not supported for EXIF extraction`);
    this.name = 'ExifTypeError';
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SIZE = 20 * 1024 * 1024; // 20 MB

const DEFAULT_ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/tiff',
];

/**
 * Valid EXIF orientation values (1–8).
 * Values outside this range are malformed and should be treated as absent.
 */
const VALID_ORIENTATIONS = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

// ---------------------------------------------------------------------------
// Helper: sanitize a string field so it cannot carry injection payloads
// ---------------------------------------------------------------------------

function sanitizeString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // Coerce to string, trim whitespace, limit to 128 characters
  const str = String(value).trim().slice(0, 128);
  // Replace any non-printable or control characters
  return str.replace(/[\x00-\x1F\x7F]/g, '').trim() || null;
}

// ---------------------------------------------------------------------------
// Helper: clamp GPS coordinates to valid ranges
// ---------------------------------------------------------------------------

function sanitizeGps(
  latitude: unknown,
  longitude: unknown,
): { latitude: number; longitude: number } | null {
  const lat = typeof latitude === 'number' ? latitude : parseFloat(String(latitude));
  const lon = typeof longitude === 'number' ? longitude : parseFloat(String(longitude));

  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  // Round to 5 decimal places (~1m precision – more than enough for evidence)
  return {
    latitude: Math.round(lat * 1e5) / 1e5,
    longitude: Math.round(lon * 1e5) / 1e5,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * extractExif
 *
 * Extracts and sanitizes EXIF metadata from a File before upload.
 *
 * Sanitization applied:
 * 1. **Size guard** – rejects files larger than `maxFileSizeBytes` (20 MB).
 * 2. **Type guard** – rejects MIME types outside the allow-list.
 * 3. **GPS privacy** – strips GPS coordinates from the summary by default
 *    (`redactGps: true`). The `gpsRedacted` flag is set so the caller can
 *    warn the user that location data was found and removed.
 * 4. **Coordinate validation** – clamped to [-90,90] × [-180,180]; non-finite
 *    values are treated as absent.
 * 5. **String injection** – Make, Model, and timestamp fields are limited to
 *    128 printable characters; control characters are stripped.
 * 6. **Orientation** – validated to be an integer 1–8; out-of-range values
 *    are treated as absent.
 * 7. **Malformed metadata** – any parse error is caught; an empty summary is
 *    returned rather than throwing, so the upload flow is never blocked.
 *
 * @throws ExifSizeError when the file exceeds `maxFileSizeBytes`.
 * @throws ExifTypeError when the MIME type is not in `allowedMimeTypes`.
 */
export async function extractExif(
  file: File,
  options: ExifOptions = {},
): Promise<ExifSummary> {
  const {
    redactGps = true,
    maxFileSizeBytes = DEFAULT_MAX_SIZE,
    allowedMimeTypes = DEFAULT_ALLOWED_TYPES,
  } = options;

  // 1. Size guard
  if (file.size > maxFileSizeBytes) {
    throw new ExifSizeError(file.size, maxFileSizeBytes);
  }

  // 2. Type guard (check MIME type; fall back gracefully if type is empty)
  const mime = (file.type || '').toLowerCase();
  if (mime && !allowedMimeTypes.includes(mime)) {
    throw new ExifTypeError(mime);
  }

  // 3. Parse – any exception from exifr is caught below
  try {
    const data = await exifr.parse(file, {
      gps: true,
      pick: [
        'Make',
        'Model',
        'DateTimeOriginal',
        'CreateDate',
        'GPSLatitude',
        'GPSLongitude',
        'Orientation',
      ],
    });

    if (!data) {
      return emptyExifSummary();
    }

    // 4. Orientation validation
    const rawOrientation = data.Orientation;
    const orientation =
      typeof rawOrientation === 'number' &&
      Number.isInteger(rawOrientation) &&
      VALID_ORIENTATIONS.has(rawOrientation)
        ? rawOrientation
        : null;

    // 5. GPS handling
    const rawGps = sanitizeGps(data.latitude, data.longitude);
    const hasGps = rawGps !== null;

    // 6. Timestamp sanitization – ISO-8601 only
    let timestamp: string | null = null;
    const rawTs = data.DateTimeOriginal ?? data.CreateDate;
    if (rawTs instanceof Date && isFinite(rawTs.getTime())) {
      timestamp = rawTs.toISOString();
    } else if (typeof rawTs === 'string') {
      // Some parsers return a raw string; attempt conversion
      const parsed = new Date(rawTs);
      if (isFinite(parsed.getTime())) {
        timestamp = parsed.toISOString();
      }
    }

    return {
      // GPS is stripped if redactGps is true
      gps: redactGps ? null : rawGps,
      gpsRedacted: redactGps && hasGps,
      timestamp,
      device: {
        make: sanitizeString(data.Make),
        model: sanitizeString(data.Model),
      },
      orientation,
    };
  } catch {
    // Malformed metadata – return empty summary so the upload is not blocked
    return emptyExifSummary();
  }
}

function emptyExifSummary(): ExifSummary {
  return {
    gps: null,
    timestamp: null,
    device: { make: null, model: null },
    orientation: null,
    gpsRedacted: false,
  };
}

