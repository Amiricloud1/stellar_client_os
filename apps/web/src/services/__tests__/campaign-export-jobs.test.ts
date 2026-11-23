import { describe, expect, it } from "vitest";
import {
  InMemoryCampaignDataSource,
  InMemoryCampaignExportJobStore,
  decodeCampaignExportPayload,
  drainExportJobs,
  enqueueExport,
  runExportJob,
  type CampaignRecord,
} from "../campaign.service";

function campaignFixture(): CampaignRecord {
  return {
    id: "campaign-export",
    creator: "creator-1",
    name: "Forest recovery",
    status: "ACTIVE",
    goalAmount: "1000",
    raisedAmount: "300",
    sponsorCount: 3,
    treeCount: 10,
    createdAt: 1,
    updatedAt: 1,
    statusChangedAt: 1,
    sponsors: [
      { id: "s1", campaignId: "campaign-export", address: "G1", amount: "100", token: "XLM", sponsoredAt: 1 },
      { id: "s2", campaignId: "campaign-export", address: "G2", amount: "100", token: "XLM", sponsoredAt: 2 },
      { id: "s3", campaignId: "campaign-export", address: "G3", amount: "100", token: "XLM", sponsoredAt: 3 },
    ],
    statusHistory: [],
  };
}

describe("versioned campaign export jobs", () => {
  it("writes v1 payloads additively for old workers and decodes legacy jobs", async () => {
    const dataSource = new InMemoryCampaignDataSource(async () => {});
    await dataSource.saveCampaign(campaignFixture());
    const store = new InMemoryCampaignExportJobStore();
    const job = await enqueueExport(
      "campaign-export",
      "requester-1",
      "json",
      {},
      store,
      10,
    );

    expect(job).toMatchObject({
      payloadVersion: 1,
      payload: { campaignId: "campaign-export", format: "json" },
      campaignId: "campaign-export",
      format: "json",
    });
    expect({ campaignId: job.campaignId, format: job.format }).toEqual({
      campaignId: "campaign-export",
      format: "json",
    });

    const legacy = { ...job, payloadVersion: undefined, payload: undefined };
    expect(decodeCampaignExportPayload(legacy)).toEqual({
      campaignId: "campaign-export",
      format: "json",
    });
    await store.save(legacy);
    const processedLegacyJob = await runExportJob(
      legacy.id,
      dataSource,
      store,
      {},
      20,
    );
    expect(processedLegacyJob.status).toBe("SUCCEEDED");
  });

  it("leaves unsupported payload versions queued for a compatible worker or rollback", async () => {
    const store = new InMemoryCampaignExportJobStore();
    const job = await enqueueExport(
      "campaign-export",
      "requester-1",
      "csv",
      {},
      store,
      10,
    );
    const futureJob = await store.save({
      ...job,
      payloadVersion: 2,
      status: "QUEUED",
      attempts: 0,
    });

    await expect(
      drainExportJobs(
        [futureJob.id],
        new InMemoryCampaignDataSource(),
        store,
      )
    ).rejects.toMatchObject({
      code: "INCOMPATIBLE_PAYLOAD",
    });

    expect(await store.get(futureJob.id)).toMatchObject({
      status: "QUEUED",
      attempts: 0,
      payloadVersion: 2,
    });
  });

  it("drains multi-unit work without exhausting retry attempts", async () => {
    const dataSource = new InMemoryCampaignDataSource(async () => {});
    await dataSource.saveCampaign(campaignFixture());
    const store = new InMemoryCampaignExportJobStore();
    const job = await enqueueExport(
      "campaign-export",
      "requester-1",
      "csv",
      { maxAttempts: 1 },
      store,
      10,
    );

    const [drained] = await drainExportJobs(
      [job.id],
      dataSource,
      store,
      { batchSize: 1 },
      20,
    );

    expect(drained.status).toBe("SUCCEEDED");
    expect(drained.progress).toBe(100);
    expect(drained.processedSponsors).toBe(3);
    expect(drained.attempts).toBe(1);
    expect(await store.getArtifact(drained.artifactKey!)).toContain("Forest recovery");
  });
});
