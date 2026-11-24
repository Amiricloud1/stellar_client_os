// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import {
  EvidenceQuarantineService,
  getEvidenceQuarantineService,
  setEvidenceQuarantineService,
} from "@/services/evidence-quarantine.service";

const ENV_KEYS = [
  "AWS_REGION",
  "AWS_S3_BUCKET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "S3_PRESIGN_EXPIRES_SECONDS",
] as const;

let savedEnv: Record<string, string | undefined> = {};

function makePresignRequest(
  body: unknown,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest("http://localhost/api/presign-upload", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_S3_BUCKET = "fundable-evidence";
  process.env.AWS_ACCESS_KEY_ID = "TEST_ACCESS_KEY_ID";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key-for-unit-tests";
  process.env.S3_PRESIGN_EXPIRES_SECONDS = "300";
  setEvidenceQuarantineService(new EvidenceQuarantineService());
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  setEvidenceQuarantineService(new EvidenceQuarantineService());
});

describe("POST /api/presign-upload (issue #280)", () => {
  it("presigns into quarantine and registers a record", async () => {
    const res = await POST(
      makePresignRequest(
        {
          campaignId: "camp-42",
          milestoneId: "ms-1",
          contentType: "image/jpeg",
        },
        { "x-actor-id": "uploader-1" }
      )
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toMatch(/^quarantine\/evidence\/camp-42\/ms-1\/.+\.jpg$/);
    expect(body.scanStatus).toBe("quarantined");
    expect(body.recoveryAction).toBe("await_scan");
    expect(body.quarantineId).toBeTruthy();

    const record = getEvidenceQuarantineService().getRecord(body.quarantineId);
    expect(record).toMatchObject({
      campaignId: "camp-42",
      milestoneId: "ms-1",
      uploaderId: "uploader-1",
      quarantineKey: body.key,
      status: "quarantined",
    });
  });

  it("rejects unsupported content types with 400", async () => {
    const res = await POST(
      makePresignRequest({
        campaignId: "camp-42",
        milestoneId: "ms-1",
        contentType: "text/html",
      })
    );

    expect(res.status).toBe(400);
  });

  it("returns 503 when S3 upload configuration is missing", async () => {
    delete process.env.AWS_S3_BUCKET;
    const res = await POST(
      makePresignRequest({
        campaignId: "camp-42",
        milestoneId: "ms-1",
        contentType: "image/png",
      })
    );

    expect(res.status).toBe(503);
  });
});
