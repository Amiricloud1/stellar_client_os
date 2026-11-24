// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVIDENCE_LOCATION_PRECISION,
  formatEvidenceCoordinates,
  LocationPrecisionError,
  minimizeCoordinates,
  minimizeEvidenceLocation,
} from "../location-precision";

describe("location-precision (issue #281)", () => {
  it("minimizes coordinates to district precision by default", () => {
    expect(DEFAULT_EVIDENCE_LOCATION_PRECISION).toBe("district");

    const result = minimizeCoordinates(-1.2921456, 36.8219462);
    expect(result).toEqual({
      latitude: -1.29,
      longitude: 36.82,
      precision: "district",
      precisionDecimals: 2,
      approxRadiusMeters: 1_110,
      minimized: true,
    });
  });

  it("supports coarser region precision and full redaction", () => {
    const region = minimizeCoordinates(-3.4653, -62.2159, {
      precision: "region",
    });
    expect(region.latitude).toBe(-3.5);
    expect(region.longitude).toBe(-62.2);
    expect(region.approxRadiusMeters).toBe(11_100);
    expect(region.minimized).toBe(true);

    const redacted = minimizeCoordinates(-3.4653, -62.2159, {
      precision: "redacted",
    });
    expect(redacted.latitude).toBeUndefined();
    expect(redacted.longitude).toBeUndefined();
    expect(redacted.precision).toBe("redacted");
    expect(redacted.precisionDecimals).toBeNull();
    expect(redacted.minimized).toBe(true);
  });

  it("enforces authorization before allowing exact location precision", () => {
    expect(() =>
      minimizeCoordinates(48.856614, 2.352222, {
        precision: "exact",
        actorRole: "public",
      })
    ).toThrowError(LocationPrecisionError);

    try {
      minimizeCoordinates(48.856614, 2.352222, {
        precision: "exact",
        actorRole: "uploader",
      });
      throw new Error("expected authorization error");
    } catch (error) {
      const locErr = error as LocationPrecisionError;
      expect(locErr.code).toBe("EXACT_PRECISION_UNAUTHORIZED");
      expect(locErr.statusCode).toBe(403);
      expect(locErr.recoveryAction).toBe("use_minimized_precision");
    }

    const verifierExact = minimizeCoordinates(48.8566149, 2.3522219, {
      precision: "exact",
      actorRole: "verifier",
    });
    expect(verifierExact.latitude).toBe(48.85661);
    expect(verifierExact.longitude).toBe(2.35222);
    expect(verifierExact.minimized).toBe(false);

    const adminExact = minimizeCoordinates(48.8566149, 2.3522219, {
      precision: "exact",
      actorRole: "admin",
    });
    expect(adminExact.precision).toBe("exact");
  });

  it("handles coordinate boundaries and normalizes negative zero", () => {
    const poles = minimizeCoordinates(-90, 180, { precision: "district" });
    expect(poles.latitude).toBe(-90);
    expect(poles.longitude).toBe(180);

    const nearZero = minimizeCoordinates(-0.001, -0.004, {
      precision: "district",
    });
    expect(Object.is(nearZero.latitude, 0)).toBe(true);
    expect(Object.is(nearZero.longitude, 0)).toBe(true);

    expect(() => minimizeCoordinates(90.001, 0)).toThrowError(
      expect.objectContaining({
        code: "INVALID_COORDINATES",
        statusCode: 400,
      })
    );
    expect(() => minimizeCoordinates(0, -180.001)).toThrowError(
      expect.objectContaining({
        code: "INVALID_COORDINATES",
        statusCode: 400,
      })
    );
    expect(() => minimizeCoordinates(Number.NaN, 10)).toThrowError(
      expect.objectContaining({
        code: "INVALID_COORDINATES",
        statusCode: 400,
      })
    );
  });

  it("rejects incomplete pairs and strips redacted coordinates", () => {
    expect(() =>
      minimizeEvidenceLocation({ latitude: -1.2921, longitude: undefined })
    ).toThrowError(
      expect.objectContaining({
        code: "INCOMPLETE_COORDINATES",
        statusCode: 400,
      })
    );

    expect(() =>
      minimizeEvidenceLocation({ latitude: undefined, longitude: 36.8219 })
    ).toThrowError(
      expect.objectContaining({
        code: "INCOMPLETE_COORDINATES",
        statusCode: 400,
      })
    );

    const redacted = minimizeEvidenceLocation(
      {
        id: "ev-1",
        latitude: -1.2921456,
        longitude: 36.8219462,
      },
      { precision: "redacted" }
    );
    expect(redacted.latitude).toBeUndefined();
    expect(redacted.longitude).toBeUndefined();
    expect(redacted.locationPrecision).toBe("redacted");

    const withoutCoords = minimizeEvidenceLocation({ id: "ev-2" });
    expect(withoutCoords).toEqual({ id: "ev-2" });
  });

  it("formats coordinates per tier and keeps legacy display", () => {
    expect(formatEvidenceCoordinates(-1.29, 36.82, "district")).toBe(
      "-1.29, 36.82 (~1.1 km)"
    );
    expect(formatEvidenceCoordinates(-1.3, 36.8, "region")).toBe(
      "-1.3, 36.8 (~11 km)"
    );
    expect(formatEvidenceCoordinates(-1.29, 36.82, "redacted")).toBe(
      "Location redacted"
    );
    expect(formatEvidenceCoordinates(-3.4653, -62.2159, undefined)).toBe(
      "-3.46530, -62.21590"
    );
    expect(
      formatEvidenceCoordinates(undefined, undefined, undefined)
    ).toBeNull();
  });
});
