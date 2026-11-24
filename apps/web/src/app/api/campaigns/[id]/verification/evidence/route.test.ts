// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as publishEvidence } from "./route";
import {
  GET as getQuarantineStatus,
  POST as scanQuarantinedEvidence,
} from "./quarantine/route";
import { buildQuarantineEvidenceKey } from "@/lib/s3";
import {
  InMemoryCampaignDataSource,
  setCampaignDataSource,
  type CampaignRecord,
} from "@/services/campaign.service";
import {
  EvidenceQuarantineService,
  getEvidenceQuarantineService,
  setEvidenceQuarantineService,
} from "@/services/evidence-quarantine.service";

const VALID_JPEG_BASE64 = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]).toString("base64");

const INFECTED_JPEG_BASE64 = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from("<script>alert(1)</script>", "utf8"),
]).toString("base64");

let originalAdminKey: string | undefined;

function buildCampaign(
  overrides: Partial<CampaignRecord> = {}
): CampaignRecord {
  return {
    id: "camp-1",
    creator: "creator-1",
    name: "Mangrove Restoration",
    status: "ACTIVE",
    goalAmount: "50000",
    raisedAmount: "12000",
    sponsorCount: 2,
    treeCount: 1000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    statusChangedAt: 1_700_000_000_000,
    sponsors: [],
    statusHistory: [],
    verificationEvidence: [],
    ...overrides,
  };
}

function makeEvidenceReq(
  body: unknown,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(
    "http://localhost/api/campaigns/camp-1/verification/evidence",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }
  );
}

function makeQuarantinePostReq(
  body: unknown,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(
    "http://localhost/api/campaigns/camp-1/verification/evidence/quarantine",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }
  );
}

function makeQuarantineGetReq(
  query: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(
    `http://localhost/api/campaigns/camp-1/verification/evidence/quarantine${query}`,
    {
      method: "GET",
      headers,
    }
  );
}

beforeEach(async () => {
  originalAdminKey = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "test-admin-secret-token";
  const ds = new InMemoryCampaignDataSource();
  await ds.saveCampaign(buildCampaign());
  setCampaignDataSource(ds);
  setEvidenceQuarantineService(new EvidenceQuarantineService());
});

afterEach(() => {
  if (originalAdminKey === undefined) {
    delete process.env.ADMIN_API_KEY;
  } else {
    process.env.ADMIN_API_KEY = originalAdminKey;
  }
  setCampaignDataSource(new InMemoryCampaignDataSource());
  setEvidenceQuarantineService(new EvidenceQuarantineService());
});

describe("verification evidence publication boundary (#280 & #281)", () => {
  it("blocks direct publication of quarantined URLs", async () => {
    const qKey = buildQuarantineEvidenceKey("camp-1", "ms-1", "image/jpeg");
    const res = await publishEvidence(
      makeEvidenceReq({
        id: "ev-raw-quarantine",
        type: "photo",
        url: `https://bucket.s3.us-east-1.amazonaws.com/${qKey}`,
        capturedAt: 1_780_000_000_000,
      }),
      { params: Promise.resolve({ id: "camp-1" }) }
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("QUARANTINE_NOT_CLEAN");
    expect(body.recoveryAction).toBe("await_scan");
  });

  it("scans quarantined evidence, publishes, and minimizes GPS", async () => {
    const qKey = buildQuarantineEvidenceKey("camp-1", "ms-1", "image/jpeg");
    const record = getEvidenceQuarantineService().registerUpload({
      campaignId: "camp-1",
      milestoneId: "ms-1",
      uploaderId: "uploader-1",
      quarantineKey: qKey,
      contentType: "image/jpeg",
    });

    // Attempting to publish before scanning fails with 409.
    const beforeScan = await publishEvidence(
      makeEvidenceReq(
        {
          id: "ev-1",
          type: "photo",
          url: `https://cdn.example/${qKey}`,
          quarantineId: record.id,
          capturedAt: 1_780_000_000_000,
          latitude: -1.2921456,
          longitude: 36.8219462,
        },
        { "x-actor-id": "uploader-1" }
      ),
      { params: Promise.resolve({ id: "camp-1" }) }
    );
    expect(beforeScan.status).toBe(409);

    // Scan via quarantine endpoint.
    const scanRes = await scanQuarantinedEvidence(
      makeQuarantinePostReq(
        {
          quarantineId: record.id,
          contentBase64: VALID_JPEG_BASE64,
        },
        { "x-actor-id": "uploader-1" }
      ),
      { params: Promise.resolve({ id: "camp-1" }) }
    );
    expect(scanRes.status).toBe(200);
    const scanBody = await scanRes.json();
    expect(scanBody.data.status).toBe("clean");

    // Owner can inspect quarantine record; other uploader gets 403.
    const statusRes = await getQuarantineStatus(
      makeQuarantineGetReq(`?quarantineId=${record.id}`, {
        "x-actor-id": "uploader-1",
      }),
      { params: Promise.resolve({ id: "camp-1" }) }
    );
    expect(statusRes.status).toBe(200);

    const forbiddenStatus = await getQuarantineStatus(
      makeQuarantineGetReq(`?quarantineId=${record.id}`, {
        "x-actor-id": "other-uploader",
      }),
      { params: Promise.resolve({ id: "camp-1" }) }
    );
    expect(forbiddenStatus.status).toBe(403);

    // Publish after clean scan succeeds and minimizes GPS to district (~1.1 km).
    const publishRes = await publishEvidence(
      makeEvidenceReq(
        {
          id: "ev-1",
          type: "photo",
          url: "https://cdn.example/evidence/camp-1/ms-1/ev-1.jpg",
          quarantineId: record.id,
          capturedAt: 1_780_000_000_000,
          latitude: -1.2921456,
          longitude: 36.8219462,
        },
        { "x-actor-id": "uploader-1" }
      ),
      { params: Promise.resolve({ id: "camp-1" }) }
    );

    expect(publishRes.status).toBe(201);
    const body = await publishRes.json();
    expect(body.data.latitude).toBe(-1.29);
    expect(body.data.longitude).toBe(36.82);
    expect(body.data.locationPrecision).toBe("district");
    expect(body.data.scanStatus).toBe("published");
    expect(body.data.publishedKey).toMatch(/^evidence\/camp-1\/ms-1\/.+\.jpg$/);
  });

  it("rejects infected uploads with 422 and blocks publication", async () => {
    const qKey = buildQuarantineEvidenceKey("camp-1", "ms-1", "image/jpeg");
    const record = getEvidenceQuarantineService().registerUpload({
      campaignId: "camp-1",
      milestoneId: "ms-1",
      uploaderId: "uploader-1",
      quarantineKey: qKey,
      contentType: "image/jpeg",
    });

    const scanRes = await scanQuarantinedEvidence(
      makeQuarantinePostReq(
        {
          quarantineId: record.id,
          contentBase64: INFECTED_JPEG_BASE64,
        },
        { "x-actor-id": "uploader-1" }
      ),
      { params: Promise.resolve({ id: "camp-1" }) }
    );
    expect(scanRes.status).toBe(422);
    const scanBody = await scanRes.json();
    expect(scanBody.data.status).toBe("infected");
    expect(scanBody.data.recoveryAction).toBe("reupload_clean_file");

    const publishRes = await publishEvidence(
      makeEvidenceReq(
        {
          id: "ev-infected",
          type: "photo",
          url: "https://cdn.example/evidence/camp-1/ms-1/infected.jpg",
          quarantineId: record.id,
          capturedAt: 1_780_000_000_000,
        },
        { "x-actor-id": "uploader-1" }
      ),
      { params: Promise.resolve({ id: "camp-1" }) }
    );
    expect(publishRes.status).toBe(422);
    const body = await publishRes.json();
    expect(body.code).toBe("INFECTED_EVIDENCE");
    expect(body.recoveryAction).toBe("reupload_clean_file");
  });

  it("enforces redacted precision and exact authorization", async () => {
    // Unprivileged caller requesting exact precision is rejected with 403.
    const denied = await publishEvidence(
      makeEvidenceReq(
        {
          id: "ev-exact-denied",
          type: "photo",
          url: "https://cdn.example/ev-exact.jpg",
          capturedAt: 1_780_000_000_000,
          latitude: -1.2921456,
          longitude: 36.8219462,
          locationPrecision: "exact",
        },
        { "x-actor-id": "uploader-1" }
      ),
      { params: Promise.resolve({ id: "camp-1" }) }
    );
    expect(denied.status).toBe(403);
    const deniedBody = await denied.json();
    expect(deniedBody.code).toBe("EXACT_PRECISION_UNAUTHORIZED");
    expect(deniedBody.recoveryAction).toBe("use_minimized_precision");

    // Admin with valid bearer token may store exact coordinates.
    const allowed = await publishEvidence(
      makeEvidenceReq(
        {
          id: "ev-exact-admin",
          type: "photo",
          url: "https://cdn.example/ev-exact-admin.jpg",
          capturedAt: 1_780_000_000_000,
          latitude: -1.2921456,
          longitude: 36.8219462,
          locationPrecision: "exact",
        },
        { authorization: "Bearer test-admin-secret-token" }
      ),
      { params: Promise.resolve({ id: "camp-1" }) }
    );
    expect(allowed.status).toBe(201);
    const allowedBody = await allowed.json();
    expect(allowedBody.data.latitude).toBe(-1.29215);
    expect(allowedBody.data.longitude).toBe(36.82195);
    expect(allowedBody.data.locationPrecision).toBe("exact");

    // Redacted mode strips coordinates completely.
    const redacted = await publishEvidence(
      makeEvidenceReq({
        id: "ev-redacted",
        type: "photo",
        url: "https://cdn.example/ev-redacted.jpg",
        capturedAt: 1_780_000_000_000,
        latitude: -1.2921456,
        longitude: 36.8219462,
        locationPrecision: "redacted",
      }),
      { params: Promise.resolve({ id: "camp-1" }) }
    );
    expect(redacted.status).toBe(201);
    const redactedBody = await redacted.json();
    expect(redactedBody.data.latitude).toBeUndefined();
    expect(redactedBody.data.longitude).toBeUndefined();
    expect(redactedBody.data.locationPrecision).toBe("redacted");

    // Incomplete coordinate pair is rejected with 400.
    const incomplete = await publishEvidence(
      makeEvidenceReq({
        id: "ev-partial",
        type: "photo",
        url: "https://cdn.example/ev-partial.jpg",
        capturedAt: 1_780_000_000_000,
        latitude: -1.2921,
      }),
      { params: Promise.resolve({ id: "camp-1" }) }
    );
    expect(incomplete.status).toBe(400);
    const incompleteBody = await incomplete.json();
    expect(incompleteBody.code).toBe("INCOMPLETE_COORDINATES");
  });
});
