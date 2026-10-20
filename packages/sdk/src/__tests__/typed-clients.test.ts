import { describe, it, expect } from "vitest";
import {
  PaymentStreamClient,
  DistributorClient,
  PlanterClient,
  CampaignFundingClient,
  CampaignEscrowClient,
  CampaignDiversityClient,
  CampaignInsuranceClient,
} from "../index.js";

describe("Typed Clients for Supported Contracts (Issue #40)", () => {
  it("exports typed contract clients for all core protocol contracts", () => {
    expect(PaymentStreamClient).toBeDefined();
    expect(DistributorClient).toBeDefined();
    expect(PlanterClient).toBeDefined();
    expect(CampaignFundingClient).toBeDefined();
    expect(CampaignEscrowClient).toBeDefined();
    expect(CampaignDiversityClient).toBeDefined();
    expect(CampaignInsuranceClient).toBeDefined();
  });

  it("verifies PlanterClient has expected methods", () => {
    const proto = PlanterClient.prototype;
    expect(typeof proto.initialize).toBe("function");
    expect(typeof proto.registerPlanter).toBe("function");
    expect(typeof proto.completeJob).toBe("function");
    expect(typeof proto.claimReferralReward).toBe("function");
    expect(typeof proto.getPlanter).toBe("function");
    expect(typeof proto.getReferralInfo).toBe("function");
    expect(typeof proto.getRewardAmount).toBe("function");
    expect(typeof proto.setRewardAmount).toBe("function");
  });

  it("verifies PaymentStreamClient has expected methods", () => {
    const proto = PaymentStreamClient.prototype;
    expect(typeof proto.createStream).toBe("function");
    expect(typeof proto.deposit).toBe("function");
    expect(typeof proto.withdraw).toBe("function");
    expect(typeof proto.pauseStream).toBe("function");
    expect(typeof proto.resumeStream).toBe("function");
    expect(typeof proto.cancelStream).toBe("function");
  });
});
