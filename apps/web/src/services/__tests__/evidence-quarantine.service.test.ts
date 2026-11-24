// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildQuarantineEvidenceKey,
  isQuarantineEvidenceKey,
  promoteQuarantineKeyToPublished,
} from "@/lib/s3";
import {
  EvidenceQuarantineError,
  EvidenceQuarantineService,
  MAX_EVIDENCE_SCAN_BYTES,
  scanEvidenceBytes,
  type EvidenceActor,
  type EvidenceScanner,
} from "../evidence-quarantine.service";

const VALID_JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const VALID_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const VALID_WEBP = Buffer.from(
  "RIFF\x18\x00\x00\x00WEBPVP8 \x00\x00",
  "latin1"
);
const VALID_HEIC = Buffer.from(
  "\x00\x00\x00\x18ftypheic\x00\x00\x00\x00",
  "latin1"
);
const VALID_PDF = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
  "latin1"
);

const UPLOADER: EvidenceActor = { id: "uploader-1", role: "uploader" };
const OTHER_UPLOADER: EvidenceActor = { id: "uploader-2", role: "uploader" };
const VERIFIER: EvidenceActor = { id: "verifier-1", role: "verifier" };
const ADMIN: EvidenceActor = { id: "admin-1", role: "admin" };

describe("EvidenceQuarantineService (issue #280)", () => {
  it("completes the quarantine -> scan -> publish lifecycle", async () => {
    let clock = 1_700_000_000_000;
    const service = new EvidenceQuarantineService({
      now: () => (clock += 100),
    });
    const quarantineKey = buildQuarantineEvidenceKey("42", "1", "image/jpeg");

    expect(isQuarantineEvidenceKey(quarantineKey)).toBe(true);

    const registered = service.registerUpload({
      campaignId: "42",
      milestoneId: "1",
      uploaderId: UPLOADER.id,
      quarantineKey,
      contentType: "image/jpeg",
    });

    expect(registered.status).toBe("quarantined");
    expect(registered.recoveryAction).toBe("await_scan");

    const scanned = await service.scanEvidence(
      registered.id,
      VALID_JPEG,
      UPLOADER
    );
    expect(scanned.status).toBe("clean");
    expect(scanned.recoveryAction).toBe("ready_to_publish");
    expect(scanned.findings).toEqual([]);
    expect(scanned.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(scanned.byteLength).toBe(VALID_JPEG.byteLength);

    const published = service.markPublished(registered.id, "42", UPLOADER);
    expect(published.status).toBe("published");
    expect(published.recoveryAction).toBe("none");
    expect(published.publishedKey).toBe(
      promoteQuarantineKeyToPublished(quarantineKey, "42", "1")
    );
    expect(published.publishedKey).toMatch(/^evidence\/42\/1\/.+\.jpg$/);

    // Idempotent re-publish for the same campaign succeeds cleanly.
    const repeated = service.markPublished(registered.id, "42", VERIFIER);
    expect(repeated.publishedKey).toBe(published.publishedKey);
  });

  it("validates magic bytes for all allowed evidence content types", () => {
    expect(
      scanEvidenceBytes({
        content: VALID_JPEG,
        declaredContentType: "image/jpeg",
        quarantineKey: "quarantine/evidence/1/1/a.jpg",
      }).clean
    ).toBe(true);
    expect(
      scanEvidenceBytes({
        content: VALID_PNG,
        declaredContentType: "image/png",
        quarantineKey: "quarantine/evidence/1/1/a.png",
      }).clean
    ).toBe(true);
    expect(
      scanEvidenceBytes({
        content: VALID_WEBP,
        declaredContentType: "image/webp",
        quarantineKey: "quarantine/evidence/1/1/a.webp",
      }).clean
    ).toBe(true);
    expect(
      scanEvidenceBytes({
        content: VALID_HEIC,
        declaredContentType: "image/heic",
        quarantineKey: "quarantine/evidence/1/1/a.heic",
      }).clean
    ).toBe(true);
    expect(
      scanEvidenceBytes({
        content: VALID_PDF,
        declaredContentType: "application/pdf",
        quarantineKey: "quarantine/evidence/1/1/a.pdf",
      }).clean
    ).toBe(true);
  });

  it("rejects empty, oversized, and magic-byte mismatched payloads", () => {
    const empty = scanEvidenceBytes({
      content: new Uint8Array(0),
      declaredContentType: "image/jpeg",
      quarantineKey: "quarantine/evidence/1/1/a.jpg",
    });
    expect(empty.clean).toBe(false);
    expect(empty.findings[0]?.code).toBe("EMPTY_PAYLOAD");

    const fakeLarge = {
      byteLength: MAX_EVIDENCE_SCAN_BYTES + 1,
    } as Uint8Array;
    const oversized = scanEvidenceBytes({
      content: fakeLarge,
      declaredContentType: "image/jpeg",
      quarantineKey: "quarantine/evidence/1/1/a.jpg",
    });
    expect(oversized.clean).toBe(false);
    expect(oversized.findings[0]?.code).toBe("PAYLOAD_TOO_LARGE");

    const mismatch = scanEvidenceBytes({
      content: VALID_PNG,
      declaredContentType: "image/jpeg",
      quarantineKey: "quarantine/evidence/1/1/a.jpg",
    });
    expect(mismatch.clean).toBe(false);
    const hasMismatch = mismatch.findings.some(
      (f) => f.code === "MAGIC_BYTE_MISMATCH"
    );
    expect(hasMismatch).toBe(true);
  });

  it("detects malware, executables, and active polyglots", async () => {
    const service = new EvidenceQuarantineService();
    const eicarPrefix = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$";
    const eicarSuffix = "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    const infectedJpeg = Buffer.concat([
      Buffer.from(VALID_JPEG),
      Buffer.from(eicarPrefix + eicarSuffix, "latin1"),
    ]);

    const record = service.registerUpload({
      campaignId: "42",
      milestoneId: "1",
      uploaderId: UPLOADER.id,
      quarantineKey: buildQuarantineEvidenceKey("42", "1", "image/jpeg"),
      contentType: "image/jpeg",
    });

    const scanned = await service.scanEvidence(
      record.id,
      infectedJpeg,
      UPLOADER
    );
    expect(scanned.status).toBe("infected");
    expect(scanned.recoveryAction).toBe("reupload_clean_file");
    expect(
      scanned.findings.some((f) => f.code === "MALWARE_SIGNATURE_DETECTED")
    ).toBe(true);

    // Infected evidence is permanently blocked from publication.
    expect(() => service.markPublished(record.id, "42", ADMIN)).toThrowError(
      EvidenceQuarantineError
    );
    try {
      service.markPublished(record.id, "42", ADMIN);
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceQuarantineError);
      const qErr = error as EvidenceQuarantineError;
      expect(qErr.code).toBe("INFECTED_EVIDENCE");
      expect(qErr.statusCode).toBe(422);
      expect(qErr.recoveryAction).toBe("reupload_clean_file");
    }

    // Executable binary and script-bearing PDF payloads are rejected.
    const peBinary = Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1");
    expect(
      scanEvidenceBytes({
        content: peBinary,
        declaredContentType: "image/jpeg",
        quarantineKey: "quarantine/evidence/42/1/pe.jpg",
      }).findings.some((f) => f.code === "EXECUTABLE_BINARY_DETECTED")
    ).toBe(true);

    const xssJpeg = Buffer.concat([
      Buffer.from(VALID_JPEG),
      Buffer.from("<script>alert(1)</script>", "utf8"),
    ]);
    expect(
      scanEvidenceBytes({
        content: xssJpeg,
        declaredContentType: "image/jpeg",
        quarantineKey: "quarantine/evidence/42/1/xss.jpg",
      }).findings.some((f) => f.code === "EMBEDDED_SCRIPT_TAG")
    ).toBe(true);

    const maliciousPdf = Buffer.from(
      "%PDF-1.7\n1 0 obj << /OpenAction << /S /JavaScript >> >> endobj",
      "latin1"
    );
    const pdfScan = scanEvidenceBytes({
      content: maliciousPdf,
      declaredContentType: "application/pdf",
      quarantineKey: "quarantine/evidence/42/1/bad.pdf",
    });
    expect(pdfScan.clean).toBe(false);
    const hasPdfJs = pdfScan.findings.some(
      (f) => f.code === "PDF_JAVASCRIPT_ACTION"
    );
    expect(hasPdfJs).toBe(true);
  });

  it("blocks unscanned evidence and enforces authorization", async () => {
    const service = new EvidenceQuarantineService();
    const record = service.registerUpload({
      campaignId: "42",
      milestoneId: "1",
      uploaderId: UPLOADER.id,
      quarantineKey: buildQuarantineEvidenceKey("42", "1", "image/jpeg"),
      contentType: "image/jpeg",
    });

    // Unscanned upload cannot be published.
    try {
      service.markPublished(record.id, "42", UPLOADER);
      throw new Error("expected rejection");
    } catch (error) {
      const qErr = error as EvidenceQuarantineError;
      expect(qErr.code).toBe("QUARANTINE_NOT_CLEAN");
      expect(qErr.statusCode).toBe(409);
      expect(qErr.recoveryAction).toBe("await_scan");
    }

    // Unauthorized uploader cannot scan another uploader's quarantined file.
    await expect(
      service.scanEvidence(record.id, VALID_JPEG, OTHER_UPLOADER)
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      statusCode: 403,
    });

    // Authorized uploader scans cleanly.
    await service.scanEvidence(record.id, VALID_JPEG, UPLOADER);

    // Cross-campaign publication is rejected.
    expect(() =>
      service.markPublished(record.id, "other-campaign", UPLOADER)
    ).toThrowError(
      expect.objectContaining({ code: "UNAUTHORIZED", statusCode: 403 })
    );

    // Another uploader cannot publish someone else's clean record.
    expect(() =>
      service.markPublished(record.id, "42", OTHER_UPLOADER)
    ).toThrowError(
      expect.objectContaining({ code: "UNAUTHORIZED", statusCode: 403 })
    );
  });

  it("fails closed on scanner errors and retries cleanly", async () => {
    let attempts = 0;
    const flakyScanner: EvidenceScanner = {
      async scan(input) {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("Antivirus daemon timeout");
        }
        return scanEvidenceBytes(input);
      },
    };

    const service = new EvidenceQuarantineService({
      scanner: flakyScanner,
      defaultMaxScanAttempts: 2,
    });
    const record = service.registerUpload({
      campaignId: "42",
      milestoneId: "1",
      uploaderId: UPLOADER.id,
      quarantineKey: buildQuarantineEvidenceKey("42", "1", "image/jpeg"),
      contentType: "image/jpeg",
    });

    const firstAttempt = await service.scanEvidence(
      record.id,
      VALID_JPEG,
      UPLOADER
    );
    expect(firstAttempt.status).toBe("scan_failed");
    expect(firstAttempt.recoveryAction).toBe("retry_scan");
    expect(firstAttempt.lastError).toBe("Antivirus daemon timeout");
    expect(firstAttempt.scanAttempts).toBe(1);

    // Cannot publish while scan_failed.
    expect(() => service.markPublished(record.id, "42", UPLOADER)).toThrowError(
      expect.objectContaining({
        code: "SCANNER_UNAVAILABLE",
        statusCode: 503,
        recoveryAction: "retry_scan",
      })
    );

    // Retry succeeds and unlocks publication.
    const secondAttempt = await service.scanEvidence(
      record.id,
      VALID_JPEG,
      UPLOADER
    );
    expect(secondAttempt.status).toBe("clean");
    expect(secondAttempt.recoveryAction).toBe("ready_to_publish");
    expect(secondAttempt.scanAttempts).toBe(2);

    const published = service.markPublished(record.id, "42", UPLOADER);
    expect(published.status).toBe("published");
  });

  it("exhausts bounded retries and directs re-upload recovery", async () => {
    const failingScanner: EvidenceScanner = {
      async scan() {
        throw new Error("Scanner offline");
      },
    };
    const service = new EvidenceQuarantineService({
      scanner: failingScanner,
      defaultMaxScanAttempts: 2,
    });
    const record = service.registerUpload({
      campaignId: "42",
      milestoneId: "1",
      uploaderId: UPLOADER.id,
      quarantineKey: buildQuarantineEvidenceKey("42", "1", "image/jpeg"),
      contentType: "image/jpeg",
    });

    await service.scanEvidence(record.id, VALID_JPEG, UPLOADER);
    const second = await service.scanEvidence(record.id, VALID_JPEG, UPLOADER);
    expect(second.status).toBe("scan_failed");
    expect(second.recoveryAction).toBe("reupload_clean_file");

    await expect(
      service.scanEvidence(record.id, VALID_JPEG, UPLOADER)
    ).rejects.toMatchObject({
      code: "SCAN_RETRY_EXHAUSTED",
      statusCode: 409,
      recoveryAction: "reupload_clean_file",
    });
  });

  it("rejects invalid quarantine keys with traversal or wrong prefix", () => {
    const service = new EvidenceQuarantineService();
    expect(() =>
      service.registerUpload({
        campaignId: "42",
        milestoneId: "1",
        uploaderId: UPLOADER.id,
        quarantineKey: "evidence/42/1/not-quarantined.jpg",
        contentType: "image/jpeg",
      })
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_KEY", statusCode: 400 })
    );
  });
});
