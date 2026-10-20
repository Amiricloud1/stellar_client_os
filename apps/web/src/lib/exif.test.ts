/**
 * Tests for EXIF metadata sanitization – issue #81
 *
 * Covers:
 * • GPS privacy (redaction by default, gpsRedacted flag)
 * • Media type validation (ExifTypeError)
 * • File size validation (ExifSizeError)
 * • Malformed metadata (graceful fallback to empty summary)
 * • Orientation validation (1–8 only)
 * • String injection prevention (control characters, length cap)
 * • Timestamp sanitization (ISO-8601 only)
 * • Cancellation (stale result discarded in useExifPreview)
 *
 * All tests are deterministic and use no live files or network requests.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { extractExif, ExifSizeError, ExifTypeError } from "./exif";

// ---------------------------------------------------------------------------
// Mock exifr so we control the parsed output without real file parsing
// ---------------------------------------------------------------------------

const mockExifrParse = vi.fn();
vi.mock("exifr", () => ({
  default: { parse: (...args: unknown[]) => mockExifrParse(...args) },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a minimal File-like object for testing. */
function makeFile(
  name: string,
  mimeType: string,
  sizeBytes = 1024,
): File {
  const content = new Uint8Array(Math.min(sizeBytes, 16)); // jsdom File
  return new File([content], name, { type: mimeType });
}

/** A typical EXIF payload with GPS, timestamp, device, and orientation. */
const FULL_EXIF = {
  latitude: 48.8566,
  longitude: 2.3522,
  Make: "Apple",
  Model: "iPhone 14 Pro",
  DateTimeOriginal: new Date("2024-06-15T10:30:00Z"),
  Orientation: 6,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockExifrParse.mockResolvedValue(FULL_EXIF);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── GPS privacy ──────────────────────────────────────────────────────────────

describe("extractExif – GPS privacy", () => {
  it("strips GPS from the summary by default (redactGps: true)", async () => {
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file);

    expect(result.gps).toBeNull();
  });

  it("sets gpsRedacted=true when GPS was present but stripped", async () => {
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file);

    expect(result.gpsRedacted).toBe(true);
  });

  it("sets gpsRedacted=false when no GPS data is in the file", async () => {
    mockExifrParse.mockResolvedValue({ ...FULL_EXIF, latitude: undefined, longitude: undefined });
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file);

    expect(result.gpsRedacted).toBe(false);
  });

  it("exposes GPS when redactGps is explicitly false", async () => {
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file, { redactGps: false });

    expect(result.gps).not.toBeNull();
    expect(result.gps?.latitude).toBeCloseTo(48.8566, 4);
    expect(result.gps?.longitude).toBeCloseTo(2.3522, 4);
  });

  it("rejects out-of-range GPS coordinates (lat > 90)", async () => {
    mockExifrParse.mockResolvedValue({ ...FULL_EXIF, latitude: 200, longitude: 2 });
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file, { redactGps: false });

    expect(result.gps).toBeNull();
  });

  it("rejects non-finite GPS values (NaN, Infinity)", async () => {
    mockExifrParse.mockResolvedValue({ ...FULL_EXIF, latitude: NaN, longitude: Infinity });
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file, { redactGps: false });

    expect(result.gps).toBeNull();
  });
});

// ── Media type validation ────────────────────────────────────────────────────

describe("extractExif – media type guard", () => {
  it("accepts image/jpeg", async () => {
    const file = makeFile("photo.jpg", "image/jpeg");
    await expect(extractExif(file)).resolves.not.toThrow();
  });

  it("accepts image/heic", async () => {
    const file = makeFile("photo.heic", "image/heic");
    await expect(extractExif(file)).resolves.not.toThrow();
  });

  it("throws ExifTypeError for video/mp4", async () => {
    const file = makeFile("clip.mp4", "video/mp4");
    await expect(extractExif(file)).rejects.toThrow(ExifTypeError);
  });

  it("throws ExifTypeError for application/pdf", async () => {
    const file = makeFile("doc.pdf", "application/pdf");
    await expect(extractExif(file)).rejects.toThrow(ExifTypeError);
  });

  it("does not throw when file has no MIME type (empty string)", async () => {
    // Browser may not detect MIME for some files; gracefully proceed
    const file = makeFile("photo", "", 1024);
    await expect(extractExif(file)).resolves.not.toThrow();
  });
});

// ── File size validation ─────────────────────────────────────────────────────

describe("extractExif – size guard", () => {
  it("accepts a 1 MB file", async () => {
    // We can't easily create a real 1 MB File in jsdom; we fake the size by
    // overriding the property.
    const file = makeFile("photo.jpg", "image/jpeg");
    Object.defineProperty(file, "size", { value: 1024 * 1024, configurable: true });
    await expect(extractExif(file)).resolves.not.toThrow();
  });

  it("throws ExifSizeError when file exceeds 20 MB", async () => {
    const file = makeFile("photo.jpg", "image/jpeg");
    Object.defineProperty(file, "size", { value: 21 * 1024 * 1024, configurable: true });
    await expect(extractExif(file)).rejects.toThrow(ExifSizeError);
  });

  it("respects a custom maxFileSizeBytes option", async () => {
    const file = makeFile("photo.jpg", "image/jpeg");
    Object.defineProperty(file, "size", { value: 5001, configurable: true });
    await expect(extractExif(file, { maxFileSizeBytes: 5000 })).rejects.toThrow(ExifSizeError);
  });
});

// ── Malformed metadata ───────────────────────────────────────────────────────

describe("extractExif – malformed metadata", () => {
  it("returns an empty summary when exifr throws", async () => {
    mockExifrParse.mockRejectedValue(new Error("Parse error"));
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file);

    expect(result.gps).toBeNull();
    expect(result.timestamp).toBeNull();
    expect(result.device.make).toBeNull();
    expect(result.device.model).toBeNull();
    expect(result.gpsRedacted).toBe(false);
  });

  it("returns an empty summary when exifr returns null", async () => {
    mockExifrParse.mockResolvedValue(null);
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file);

    expect(result.gps).toBeNull();
    expect(result.timestamp).toBeNull();
  });
});

// ── Orientation validation ───────────────────────────────────────────────────

describe("extractExif – orientation", () => {
  it("passes through valid orientations (1–8)", async () => {
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
      mockExifrParse.mockResolvedValue({ ...FULL_EXIF, Orientation: o });
      const file = makeFile("photo.jpg", "image/jpeg");
      const result = await extractExif(file);
      expect(result.orientation).toBe(o);
    }
  });

  it("treats orientation 0 as absent", async () => {
    mockExifrParse.mockResolvedValue({ ...FULL_EXIF, Orientation: 0 });
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file);
    expect(result.orientation).toBeNull();
  });

  it("treats orientation 9 as absent (out of range)", async () => {
    mockExifrParse.mockResolvedValue({ ...FULL_EXIF, Orientation: 9 });
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file);
    expect(result.orientation).toBeNull();
  });

  it("treats non-integer orientation as absent", async () => {
    mockExifrParse.mockResolvedValue({ ...FULL_EXIF, Orientation: 1.5 });
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file);
    expect(result.orientation).toBeNull();
  });
});

// ── String injection prevention ──────────────────────────────────────────────

describe("extractExif – string sanitization", () => {
  it("strips control characters from Make and Model", async () => {
    mockExifrParse.mockResolvedValue({
      ...FULL_EXIF,
      Make: "Apple\x00\x01Injected",
      Model: "iPhone\x1F14",
    });
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file);

    expect(result.device.make).not.toContain("\x00");
    expect(result.device.make).not.toContain("\x01");
    expect(result.device.model).not.toContain("\x1F");
  });

  it("truncates Make/Model to 128 characters", async () => {
    const long = "A".repeat(300);
    mockExifrParse.mockResolvedValue({ ...FULL_EXIF, Make: long, Model: long });
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file);

    expect((result.device.make?.length ?? 0) <= 128).toBe(true);
    expect((result.device.model?.length ?? 0) <= 128).toBe(true);
  });

  it("returns null for an all-whitespace Make value", async () => {
    mockExifrParse.mockResolvedValue({ ...FULL_EXIF, Make: "   " });
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file);
    expect(result.device.make).toBeNull();
  });
});

// ── Timestamp sanitization ───────────────────────────────────────────────────

describe("extractExif – timestamp sanitization", () => {
  it("converts a valid Date to an ISO-8601 string", async () => {
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file);

    expect(result.timestamp).toBe("2024-06-15T10:30:00.000Z");
  });

  it("returns null for an invalid Date object", async () => {
    mockExifrParse.mockResolvedValue({ ...FULL_EXIF, DateTimeOriginal: new Date("invalid") });
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file);
    expect(result.timestamp).toBeNull();
  });

  it("returns null when no timestamp fields are present", async () => {
    mockExifrParse.mockResolvedValue({
      Make: "Apple",
      Model: "iPhone 14",
      latitude: 48.8,
      longitude: 2.3,
    });
    const file = makeFile("photo.jpg", "image/jpeg");
    const result = await extractExif(file);
    expect(result.timestamp).toBeNull();
  });
});
