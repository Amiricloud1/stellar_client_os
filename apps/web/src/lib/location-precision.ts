export const LOCATION_PRECISION_LEVELS = [
  "redacted",
  "region",
  "district",
  "exact",
] as const;

export type LocationPrecisionLevel = (typeof LOCATION_PRECISION_LEVELS)[number];

export type LocationViewerRole =
  | "public"
  | "uploader"
  | "verifier"
  | "operator"
  | "admin";

/**
 * Default precision applied to public campaign verification evidence.
 * 2 decimal places (~1.11 km) preserves regional accountability without
 * disclosing exact planter homes, farm parcels, or endangered habitats.
 */
export const DEFAULT_EVIDENCE_LOCATION_PRECISION: LocationPrecisionLevel =
  "district";

export const LOCATION_PRECISION_DECIMALS: Readonly<
  Record<LocationPrecisionLevel, number | null>
> = {
  redacted: null,
  region: 1,
  district: 2,
  exact: 5,
};

export const LOCATION_APPROX_RADIUS_METERS: Readonly<
  Record<LocationPrecisionLevel, number | null>
> = {
  redacted: null,
  region: 11_100,
  district: 1_110,
  exact: 1,
};

export type LocationPrecisionErrorCode =
  | "INVALID_COORDINATES"
  | "INCOMPLETE_COORDINATES"
  | "EXACT_PRECISION_UNAUTHORIZED";

export type LocationRecoveryAction =
  | "provide_valid_coordinates"
  | "use_minimized_precision";

export class LocationPrecisionError extends Error {
  readonly code: LocationPrecisionErrorCode;
  readonly statusCode: number;
  readonly recoveryAction: LocationRecoveryAction;

  constructor(
    code: LocationPrecisionErrorCode,
    message: string,
    statusCode: number,
    recoveryAction: LocationRecoveryAction
  ) {
    super(message);
    this.name = "LocationPrecisionError";
    this.code = code;
    this.statusCode = statusCode;
    this.recoveryAction = recoveryAction;
  }
}

export function isLocationPrecisionError(
  error: unknown
): error is LocationPrecisionError {
  return error instanceof LocationPrecisionError;
}

export interface MinimizeLocationOptions {
  precision?: LocationPrecisionLevel;
  actorRole?: LocationViewerRole;
}

export interface MinimizedCoordinatesResult {
  latitude?: number;
  longitude?: number;
  precision: LocationPrecisionLevel;
  precisionDecimals: number | null;
  approxRadiusMeters: number | null;
  minimized: boolean;
}

export function canRequestExactLocation(role: LocationViewerRole): boolean {
  return role === "admin" || role === "verifier";
}

function quantizeCoordinate(
  value: number,
  decimals: number,
  min: number,
  max: number
): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  const clamped = Math.min(max, Math.max(min, rounded));
  return Object.is(clamped, -0) ? 0 : clamped;
}

function assertValidCoordinates(latitude: number, longitude: number): void {
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new LocationPrecisionError(
      "INVALID_COORDINATES",
      "Coordinates must be finite values within [-90, 90] and [-180, 180]",
      400,
      "provide_valid_coordinates"
    );
  }
}

/**
 * Minimize a latitude/longitude pair to the configured precision tier.
 * Defaults to "district" (2 decimal places, ~1.11 km). Requesting "exact"
 * fails closed with 403 unless the caller holds a verifier or admin role.
 */
export function minimizeCoordinates(
  latitude: number,
  longitude: number,
  options: MinimizeLocationOptions = {}
): MinimizedCoordinatesResult {
  assertValidCoordinates(latitude, longitude);

  const precision = options.precision ?? DEFAULT_EVIDENCE_LOCATION_PRECISION;
  const actorRole = options.actorRole ?? "public";

  if (precision === "exact" && !canRequestExactLocation(actorRole)) {
    throw new LocationPrecisionError(
      "EXACT_PRECISION_UNAUTHORIZED",
      "Exact location precision requires verifier or admin authorization",
      403,
      "use_minimized_precision"
    );
  }

  if (precision === "redacted") {
    return {
      latitude: undefined,
      longitude: undefined,
      precision,
      precisionDecimals: null,
      approxRadiusMeters: null,
      minimized: true,
    };
  }

  const decimals = LOCATION_PRECISION_DECIMALS[precision];
  if (decimals === null) {
    return {
      latitude: undefined,
      longitude: undefined,
      precision: "redacted",
      precisionDecimals: null,
      approxRadiusMeters: null,
      minimized: true,
    };
  }

  const minLat = quantizeCoordinate(latitude, decimals, -90, 90);
  const minLon = quantizeCoordinate(longitude, decimals, -180, 180);

  return {
    latitude: minLat,
    longitude: minLon,
    precision,
    precisionDecimals: decimals,
    approxRadiusMeters: LOCATION_APPROX_RADIUS_METERS[precision],
    minimized: precision !== "exact",
  };
}

export interface EvidenceLocationShape {
  latitude?: number;
  longitude?: number;
  locationPrecision?: LocationPrecisionLevel;
}

/**
 * Authoritative boundary helper that enforces location minimization on a
 * campaign evidence payload prior to persistence or public publication.
 */
export function minimizeEvidenceLocation<T extends EvidenceLocationShape>(
  evidence: T,
  options: MinimizeLocationOptions = {}
): T {
  const hasLat = evidence.latitude !== undefined;
  const hasLon = evidence.longitude !== undefined;

  if (hasLat !== hasLon) {
    throw new LocationPrecisionError(
      "INCOMPLETE_COORDINATES",
      "Both latitude and longitude must be provided together",
      400,
      "provide_valid_coordinates"
    );
  }

  if (evidence.latitude === undefined || evidence.longitude === undefined) {
    if (options.precision === "redacted") {
      return { ...evidence, locationPrecision: "redacted" };
    }
    return { ...evidence };
  }

  const minimized = minimizeCoordinates(
    evidence.latitude,
    evidence.longitude,
    {
      precision:
        options.precision ??
        evidence.locationPrecision ??
        DEFAULT_EVIDENCE_LOCATION_PRECISION,
      actorRole: options.actorRole,
    }
  );

  if (minimized.precision === "redacted") {
    const rest = { ...evidence };
    delete rest.latitude;
    delete rest.longitude;
    return {
      ...rest,
      locationPrecision: "redacted",
    };
  }

  return {
    ...evidence,
    latitude: minimized.latitude,
    longitude: minimized.longitude,
    locationPrecision: minimized.precision,
  };
}

/**
 * Format evidence coordinates for UI display according to precision tier.
 * Legacy untagged evidence (precision === undefined) keeps 5-decimal formatting
 * for backwards compatibility.
 */
export function formatEvidenceCoordinates(
  latitude: number | undefined,
  longitude: number | undefined,
  precision?: LocationPrecisionLevel
): string | null {
  if (precision === "redacted") {
    return "Location redacted";
  }
  if (latitude === undefined || longitude === undefined) {
    return null;
  }
  if (precision === "region") {
    return `${latitude.toFixed(1)}, ${longitude.toFixed(1)} (~11 km)`;
  }
  if (precision === "district") {
    return `${latitude.toFixed(2)}, ${longitude.toFixed(2)} (~1.1 km)`;
  }
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}
