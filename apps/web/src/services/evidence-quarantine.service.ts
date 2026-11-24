import { createHash, randomUUID } from "node:crypto";
import {
  assertQuarantineEvidenceKeyPrefix,
  promoteQuarantineKeyToPublished,
  type AllowedContentType,
} from "@/lib/s3";

export const MAX_EVIDENCE_SCAN_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_SCAN_ATTEMPTS = 3;

export type EvidenceScanStatus =
  | "quarantined"
  | "scanning"
  | "clean"
  | "infected"
  | "scan_failed"
  | "published";

export type EvidenceRecoveryAction =
  | "await_scan"
  | "retry_scan"
  | "reupload_clean_file"
  | "ready_to_publish"
  | "none";

export type EvidenceActorRole = "uploader" | "verifier" | "operator" | "admin";

export interface EvidenceActor {
  id: string;
  role: EvidenceActorRole;
}

export interface EvidenceScanFinding {
  code: string;
  severity: "high" | "critical";
  message: string;
}

export interface EvidenceQuarantineRecord {
  id: string;
  campaignId: string;
  milestoneId: string;
  uploaderId: string;
  quarantineKey: string;
  publishedKey?: string;
  contentType: AllowedContentType;
  contentSha256?: string;
  byteLength?: number;
  status: EvidenceScanStatus;
  scanAttempts: number;
  maxScanAttempts: number;
  findings: EvidenceScanFinding[];
  lastError?: string;
  recoveryAction: EvidenceRecoveryAction;
  createdAt: number;
  updatedAt: number;
  scannedAt?: number;
  publishedAt?: number;
}

export interface RegisterQuarantineUploadInput {
  id?: string;
  campaignId: string;
  milestoneId: string;
  uploaderId: string;
  quarantineKey: string;
  contentType: AllowedContentType;
  maxScanAttempts?: number;
}

export interface EvidenceScanInput {
  content: Uint8Array;
  declaredContentType: AllowedContentType;
  quarantineKey: string;
}

export interface EvidenceScanOutput {
  clean: boolean;
  findings: EvidenceScanFinding[];
}

export interface EvidenceScanner {
  scan(input: EvidenceScanInput): Promise<EvidenceScanOutput>;
}

export type EvidenceQuarantineErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "INVALID_KEY"
  | "INVALID_STATE_TRANSITION"
  | "QUARANTINE_NOT_CLEAN"
  | "INFECTED_EVIDENCE"
  | "SCAN_RETRY_EXHAUSTED"
  | "SCANNER_UNAVAILABLE";

export class EvidenceQuarantineError extends Error {
  readonly code: EvidenceQuarantineErrorCode;
  readonly statusCode: number;
  readonly recoveryAction: EvidenceRecoveryAction;
  readonly recordStatus?: EvidenceScanStatus;

  constructor(
    code: EvidenceQuarantineErrorCode,
    message: string,
    statusCode: number,
    recoveryAction: EvidenceRecoveryAction,
    recordStatus?: EvidenceScanStatus
  ) {
    super(message);
    this.name = "EvidenceQuarantineError";
    this.code = code;
    this.statusCode = statusCode;
    this.recoveryAction = recoveryAction;
    this.recordStatus = recordStatus;
  }
}

export function isEvidenceQuarantineError(
  error: unknown
): error is EvidenceQuarantineError {
  return error instanceof EvidenceQuarantineError;
}

const EICAR_TEST_SIGNATURE =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$" +
  "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1"]);

const ACTIVE_CONTENT_PATTERNS: ReadonlyArray<{
  code: string;
  pattern: RegExp;
  message: string;
}> = [
  {
    code: "EMBEDDED_SCRIPT_TAG",
    pattern: /<\s*script\b/i,
    message: "Uploaded file contains an embedded <script> tag",
  },
  {
    code: "EMBEDDED_JAVASCRIPT_URI",
    pattern: /javascript\s*:/i,
    message: "Uploaded file contains an embedded javascript: URI",
  },
  {
    code: "EMBEDDED_SVG_PAYLOAD",
    pattern: /<\s*svg\b/i,
    message: "Uploaded file contains an embedded SVG active payload",
  },
  {
    code: "EMBEDDED_PHP_PAYLOAD",
    pattern: /<\?php\b/i,
    message: "Uploaded file contains an embedded PHP payload",
  },
];

const PDF_ACTIVE_PATTERNS: ReadonlyArray<{
  code: string;
  pattern: RegExp;
  message: string;
}> = [
  {
    code: "PDF_JAVASCRIPT_ACTION",
    pattern: /\/(?:JavaScript|JS)\b/,
    message: "Uploaded PDF contains active JavaScript actions",
  },
  {
    code: "PDF_LAUNCH_ACTION",
    pattern: /\/Launch\b/,
    message: "Uploaded PDF contains an executable /Launch action",
  },
  {
    code: "PDF_OPEN_ACTION",
    pattern: /\/OpenAction\b/,
    message: "Uploaded PDF contains an automatic /OpenAction trigger",
  },
];

function asciiSlice(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString("latin1");
}

function hasExecutableHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  // Windows PE ("MZ") or Unix script shebang ("#!")
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return true;
  if (bytes[0] === 0x23 && bytes[1] === 0x21) return true;
  if (bytes.length < 4) return false;
  // ELF ("\x7fELF")
  if (
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  ) {
    return true;
  }
  // Mach-O 32/64 big & little endian magic numbers
  const b0 = bytes[0];
  const b1 = bytes[1];
  const b2 = bytes[2];
  const b3 = bytes[3];
  const isMachOBig =
    b0 === 0xfe && b1 === 0xed && b2 === 0xfa && (b3 === 0xce || b3 === 0xcf);
  const isMachOLittle =
    (b0 === 0xce || b0 === 0xcf) && b1 === 0xfa && b2 === 0xed && b3 === 0xfe;
  return isMachOBig || isMachOLittle;
}

function matchesDeclaredMagicBytes(
  bytes: Uint8Array,
  contentType: AllowedContentType
): boolean {
  switch (contentType) {
    case "image/jpeg":
      return (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
      );
    case "image/png":
      return (
        bytes.length >= PNG_MAGIC.length &&
        PNG_MAGIC.every((byte, idx) => bytes[idx] === byte)
      );
    case "image/webp":
      return (
        bytes.length >= 12 &&
        asciiSlice(bytes, 0, 4) === "RIFF" &&
        asciiSlice(bytes, 8, 12) === "WEBP"
      );
    case "image/heic":
      return (
        bytes.length >= 12 &&
        asciiSlice(bytes, 4, 8) === "ftyp" &&
        HEIC_BRANDS.has(asciiSlice(bytes, 8, 12).toLowerCase())
      );
    case "application/pdf":
      return bytes.length >= 5 && asciiSlice(bytes, 0, 5) === "%PDF-";
    default:
      return false;
  }
}

/**
 * Deterministic, offline evidence scanner enforcing size limits, magic-byte
 * conformance, executable/EICAR signature rejection, and active-content checks.
 */
export function scanEvidenceBytes(
  input: EvidenceScanInput
): EvidenceScanOutput {
  const { content, declaredContentType } = input;
  const findings: EvidenceScanFinding[] = [];

  if (content.byteLength === 0) {
    findings.push({
      code: "EMPTY_PAYLOAD",
      severity: "high",
      message: "Uploaded evidence file is empty",
    });
    return { clean: false, findings };
  }

  if (content.byteLength > MAX_EVIDENCE_SCAN_BYTES) {
    findings.push({
      code: "PAYLOAD_TOO_LARGE",
      severity: "high",
      message: `Uploaded evidence exceeds ${MAX_EVIDENCE_SCAN_BYTES} byte limit`,
    });
    return { clean: false, findings };
  }

  if (hasExecutableHeader(content)) {
    findings.push({
      code: "EXECUTABLE_BINARY_DETECTED",
      severity: "critical",
      message: "Uploaded file carries an executable binary header",
    });
  }

  const textView = Buffer.from(content).toString("latin1");
  if (textView.includes(EICAR_TEST_SIGNATURE)) {
    findings.push({
      code: "MALWARE_SIGNATURE_DETECTED",
      severity: "critical",
      message: "Known malware test signature detected in uploaded evidence",
    });
  }

  if (!matchesDeclaredMagicBytes(content, declaredContentType)) {
    findings.push({
      code: "MAGIC_BYTE_MISMATCH",
      severity: "high",
      message: `File signature does not match declared type ${declaredContentType}`,
    });
  }

  for (const rule of ACTIVE_CONTENT_PATTERNS) {
    if (rule.pattern.test(textView)) {
      findings.push({
        code: rule.code,
        severity: "critical",
        message: rule.message,
      });
    }
  }

  if (declaredContentType === "application/pdf") {
    for (const rule of PDF_ACTIVE_PATTERNS) {
      if (rule.pattern.test(textView)) {
        findings.push({
          code: rule.code,
          severity: "critical",
          message: rule.message,
        });
      }
    }
  }

  return { clean: findings.length === 0, findings };
}

export class DefaultEvidenceScanner implements EvidenceScanner {
  async scan(input: EvidenceScanInput): Promise<EvidenceScanOutput> {
    return scanEvidenceBytes(input);
  }
}

function isPrivilegedRole(role: EvidenceActorRole): boolean {
  return role === "admin" || role === "operator" || role === "verifier";
}

function canActOnRecord(
  record: EvidenceQuarantineRecord,
  actor: EvidenceActor
): boolean {
  if (!actor.id || !actor.id.trim()) {
    return false;
  }
  if (isPrivilegedRole(actor.role)) {
    return true;
  }
  return actor.role === "uploader" && actor.id === record.uploaderId;
}

export interface EvidenceQuarantineServiceOptions {
  scanner?: EvidenceScanner;
  now?: () => number;
  defaultMaxScanAttempts?: number;
}

/**
 * Authoritative boundary enforcing quarantine, scanning, bounded retry
 * recovery, and promotion before uploaded evidence can be published.
 */
export class EvidenceQuarantineService {
  private readonly records = new Map<string, EvidenceQuarantineRecord>();
  private readonly keyIndex = new Map<string, string>();
  private readonly scanner: EvidenceScanner;
  private readonly now: () => number;
  private readonly defaultMaxScanAttempts: number;

  constructor(options: EvidenceQuarantineServiceOptions = {}) {
    this.scanner = options.scanner ?? new DefaultEvidenceScanner();
    this.now = options.now ?? (() => Date.now());
    this.defaultMaxScanAttempts = Math.max(
      1,
      Math.floor(options.defaultMaxScanAttempts ?? DEFAULT_MAX_SCAN_ATTEMPTS)
    );
  }

  registerUpload(
    input: RegisterQuarantineUploadInput
  ): EvidenceQuarantineRecord {
    try {
      assertQuarantineEvidenceKeyPrefix(
        input.quarantineKey,
        input.campaignId,
        input.milestoneId
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid quarantine key";
      throw new EvidenceQuarantineError(
        "INVALID_KEY",
        message,
        400,
        "reupload_clean_file"
      );
    }

    const uploaderId = input.uploaderId.trim();
    if (!uploaderId) {
      throw new EvidenceQuarantineError(
        "UNAUTHORIZED",
        "Uploader identity is required to register quarantined evidence",
        401,
        "none"
      );
    }

    const id = input.id?.trim() || `qev-${randomUUID()}`;
    const timestamp = this.now();
    const maxScanAttempts = Math.max(
      1,
      Math.floor(input.maxScanAttempts ?? this.defaultMaxScanAttempts)
    );

    const record: EvidenceQuarantineRecord = {
      id,
      campaignId: input.campaignId,
      milestoneId: input.milestoneId,
      uploaderId,
      quarantineKey: input.quarantineKey,
      contentType: input.contentType,
      status: "quarantined",
      scanAttempts: 0,
      maxScanAttempts,
      findings: [],
      recoveryAction: "await_scan",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.records.set(id, record);
    this.keyIndex.set(record.quarantineKey, id);
    return { ...record, findings: [...record.findings] };
  }

  getRecord(quarantineId: string): EvidenceQuarantineRecord | null {
    const record = this.records.get(quarantineId);
    if (!record) return null;
    return { ...record, findings: [...record.findings] };
  }

  getRecordByKey(quarantineKey: string): EvidenceQuarantineRecord | null {
    const id = this.keyIndex.get(quarantineKey);
    if (!id) return null;
    return this.getRecord(id);
  }

  listByCampaign(campaignId: string): EvidenceQuarantineRecord[] {
    const results: EvidenceQuarantineRecord[] = [];
    for (const record of this.records.values()) {
      if (record.campaignId === campaignId) {
        results.push({ ...record, findings: [...record.findings] });
      }
    }
    return results;
  }

  async scanEvidence(
    quarantineId: string,
    content: Uint8Array,
    actor: EvidenceActor
  ): Promise<EvidenceQuarantineRecord> {
    const record = this.records.get(quarantineId);
    if (!record) {
      throw new EvidenceQuarantineError(
        "NOT_FOUND",
        `Quarantine record "${quarantineId}" not found`,
        404,
        "reupload_clean_file"
      );
    }

    if (!canActOnRecord(record, actor)) {
      throw new EvidenceQuarantineError(
        "UNAUTHORIZED",
        "Caller is not authorized to scan this quarantined evidence",
        403,
        "none",
        record.status
      );
    }

    if (record.status === "clean" || record.status === "published") {
      return { ...record, findings: [...record.findings] };
    }

    if (record.status === "infected") {
      throw new EvidenceQuarantineError(
        "INFECTED_EVIDENCE",
        "Infected evidence cannot be re-scanned or promoted; upload a clean file",
        422,
        "reupload_clean_file",
        record.status
      );
    }

    if (record.status === "scanning") {
      throw new EvidenceQuarantineError(
        "INVALID_STATE_TRANSITION",
        "Evidence scan is already in progress",
        409,
        "await_scan",
        record.status
      );
    }

    if (record.scanAttempts >= record.maxScanAttempts) {
      record.recoveryAction = "reupload_clean_file";
      record.updatedAt = this.now();
      throw new EvidenceQuarantineError(
        "SCAN_RETRY_EXHAUSTED",
        `Scan retry budget exhausted (${record.scanAttempts}/${record.maxScanAttempts}); re-upload evidence`,
        409,
        "reupload_clean_file",
        record.status
      );
    }

    record.status = "scanning";
    record.scanAttempts += 1;
    record.updatedAt = this.now();
    record.recoveryAction = "await_scan";

    const digest = createHash("sha256").update(content).digest("hex");
    record.contentSha256 = digest;
    record.byteLength = content.byteLength;

    try {
      const scanResult = await this.scanner.scan({
        content,
        declaredContentType: record.contentType,
        quarantineKey: record.quarantineKey,
      });

      const finishedAt = this.now();
      record.scannedAt = finishedAt;
      record.updatedAt = finishedAt;
      record.lastError = undefined;

      if (scanResult.clean && scanResult.findings.length === 0) {
        record.status = "clean";
        record.findings = [];
        record.recoveryAction = "ready_to_publish";
      } else {
        record.status = "infected";
        record.findings =
          scanResult.findings.length > 0
            ? [...scanResult.findings]
            : [
                {
                  code: "SCAN_REJECTED",
                  severity: "high",
                  message: "Evidence rejected by security scanner",
                },
              ];
        record.recoveryAction = "reupload_clean_file";
      }

      return { ...record, findings: [...record.findings] };
    } catch (error) {
      const failedAt = this.now();
      record.status = "scan_failed";
      record.updatedAt = failedAt;
      record.lastError =
        error instanceof Error ? error.message : "Scanner backend error";
      record.recoveryAction =
        record.scanAttempts < record.maxScanAttempts
          ? "retry_scan"
          : "reupload_clean_file";

      return { ...record, findings: [...record.findings] };
    }
  }

  assertPublishable(
    quarantineId: string,
    campaignId: string,
    actor: EvidenceActor
  ): EvidenceQuarantineRecord {
    const record = this.records.get(quarantineId);
    if (!record) {
      throw new EvidenceQuarantineError(
        "NOT_FOUND",
        `Quarantine record "${quarantineId}" not found`,
        404,
        "reupload_clean_file"
      );
    }

    if (record.campaignId !== campaignId) {
      throw new EvidenceQuarantineError(
        "UNAUTHORIZED",
        "Quarantine record belongs to a different campaign",
        403,
        "none",
        record.status
      );
    }

    if (!canActOnRecord(record, actor)) {
      throw new EvidenceQuarantineError(
        "UNAUTHORIZED",
        "Caller is not authorized to publish this evidence",
        403,
        "none",
        record.status
      );
    }

    if (record.status === "clean" || record.status === "published") {
      return { ...record, findings: [...record.findings] };
    }

    if (record.status === "infected") {
      throw new EvidenceQuarantineError(
        "INFECTED_EVIDENCE",
        "Evidence failed security scanning and is quarantined from publication",
        422,
        "reupload_clean_file",
        record.status
      );
    }

    if (record.status === "scan_failed") {
      throw new EvidenceQuarantineError(
        "SCANNER_UNAVAILABLE",
        "Evidence security scan failed; retry scanning before publication",
        503,
        record.recoveryAction,
        record.status
      );
    }

    throw new EvidenceQuarantineError(
      "QUARANTINE_NOT_CLEAN",
      `Evidence is currently "${record.status}" and must pass scanning before publication`,
      409,
      "await_scan",
      record.status
    );
  }

  markPublished(
    quarantineId: string,
    campaignId: string,
    actor: EvidenceActor
  ): EvidenceQuarantineRecord {
    this.assertPublishable(quarantineId, campaignId, actor);
    const record = this.records.get(quarantineId);
    if (!record) {
      throw new EvidenceQuarantineError(
        "NOT_FOUND",
        `Quarantine record "${quarantineId}" not found`,
        404,
        "reupload_clean_file"
      );
    }

    if (record.status === "published" && record.publishedKey) {
      return { ...record, findings: [...record.findings] };
    }

    const publishedKey = promoteQuarantineKeyToPublished(
      record.quarantineKey,
      record.campaignId,
      record.milestoneId
    );
    const publishedAt = this.now();
    record.status = "published";
    record.publishedKey = publishedKey;
    record.publishedAt = publishedAt;
    record.updatedAt = publishedAt;
    record.recoveryAction = "none";

    return { ...record, findings: [...record.findings] };
  }
}

let defaultQuarantineService = new EvidenceQuarantineService();

export function getEvidenceQuarantineService(): EvidenceQuarantineService {
  return defaultQuarantineService;
}

export function setEvidenceQuarantineService(
  service: EvidenceQuarantineService
): void {
  defaultQuarantineService = service;
}
