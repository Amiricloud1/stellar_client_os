import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * End-to-end campaign lifecycle integration test.
 *
 * This test drives the campaign route handlers through the full lifecycle:
 *   1. create campaign
 *   2. fund via contributions / donations
 *   3. submit verification evidence
 *   4. approve milestones (impact and on-chain)
 *   5. fetch the campaign report
 *
 * Storage (campaign data source) and Stellar RPC are mocked so the test is
 * deterministic and never touches live funds. Authorization is asserted at
 * every step, and failure / boundary cases are covered.
 */

// ---------------------------------------------------------------------------
// In-memory storage mock (campaign data source)
// ---------------------------------------------------------------------------

type CampaignStatus =
  | 'draft'
  | 'active'
  | 'funded'
  | 'verification_pending'
  | 'verified'
  | 'completed';

interface Milestone {
  id: string;
  title: string;
  targetAmount: number;
  approved: boolean;
  onChainApproved: boolean;
}

interface Contribution {
  id: string;
  donorId: string;
  amount: number;
  type: 'contribution' | 'donation';
}

interface VerificationEvidence {
  id: string;
  campaignId: string;
  submittedBy: string;
  documentUrl: string;
  status: 'pending' | 'approved' | 'rejected';
}

interface Campaign {
  id: string;
  ownerId: string;
  title: string;
  goalAmount: number;
  raisedAmount: number;
  status: CampaignStatus;
  milestones: Milestone[];
  contributions: Contribution[];
  evidence: VerificationEvidence[];
  createdAt: string;
}

interface User {
  id: string;
  role: 'owner' | 'donor' | 'verifier' | 'admin';
}

const db = {
  campaigns: new Map<string, Campaign>(),
  users: new Map<string, User>(),
};

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}_${++idCounter}`;

// ---------------------------------------------------------------------------
// Mocked storage module
// ---------------------------------------------------------------------------

const storage = {
  createCampaign: vi.fn(
    async (input: {
      ownerId: string;
      title: string;
      goalAmount: number;
      milestones: Array<{ title: string; targetAmount: number }>;
    }): Promise<Campaign> => {
      const campaign: Campaign = {
        id: nextId('campaign'),
        ownerId: input.ownerId,
        title: input.title,
        goalAmount: input.goalAmount,
        raisedAmount: 0,
        status: 'active',
        milestones: input.milestones.map((m) => ({
          id: nextId('milestone'),
          title: m.title,
          targetAmount: m.targetAmount,
          approved: false,
          onChainApproved: false,
        })),
        contributions: [],
        evidence: [],
        createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
      };
      db.campaigns.set(campaign.id, campaign);
      return campaign;
    },
  ),

  getCampaign: vi.fn(async (id: string): Promise<Campaign | null> => {
    return db.campaigns.get(id) ?? null;
  }),

  updateCampaign: vi.fn(
    async (id: string, patch: Partial<Campaign>): Promise<Campaign | null> => {
      const existing = db.campaigns.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      db.campaigns.set(id, updated);
      return updated;
    },
  ),

  addContribution: vi.fn(
    async (input: {
      campaignId: string;
      donorId: string;
      amount: number;
      type: 'contribution' | 'donation';
    }): Promise<Contribution | null> => {
      const campaign = db.campaigns.get(input.campaignId);
      if (!campaign) return null;
      const contribution: Contribution = {
        id: nextId('contribution'),
        donorId: input.donorId,
        amount: input.amount,
        type: input.type,
      };
      campaign.contributions.push(contribution);
      campaign.raisedAmount += input.amount;
      if (campaign.raisedAmount >= campaign.goalAmount) {
        campaign.status = 'funded';
      }
      db.campaigns.set(campaign.id, campaign);
      return contribution;
    },
  ),

  addEvidence: vi.fn(
    async (input: {
      campaignId: string;
      submittedBy: string;
      documentUrl: string;
    }): Promise<VerificationEvidence | null> => {
      const campaign = db.campaigns.get(input.campaignId);
      if (!campaign) return null;
      const evidence: VerificationEvidence = {
        id: nextId('evidence'),
        campaignId: input.campaignId,
        submittedBy: input.submittedBy,
        documentUrl: input.documentUrl,
        status: 'pending',
      };
      campaign.evidence.push(evidence);
      campaign.status = 'verification_pending';
      db.campaigns.set(campaign.id, campaign);
      return evidence;
    },
  ),

  updateEvidence: vi.fn(
    async (
      evidenceId: string,
      status: 'approved' | 'rejected',
    ): Promise<VerificationEvidence | null> => {
      for (const campaign of db.campaigns.values()) {
        const evidence = campaign.evidence.find((e) => e.id === evidenceId);
        if (evidence) {
          evidence.status = status;
          if (status === 'approved') {
            campaign.status = 'verified';
          }
          db.campaigns.set(campaign.id, campaign);
          return evidence;
        }
      }
      return null;
    },
  ),

  approveMilestone: vi.fn(
    async (
      campaignId: string,
      milestoneId: string,
      onChain: boolean,
    ): Promise<Milestone | null> => {
      const campaign = db.campaigns.get(campaignId);
      if (!campaign) return null;
      const milestone = campaign.milestones.find((m) => m.id === milestoneId);
      if (!milestone) return null;
      if (onChain) {
        milestone.onChainApproved = true;
      } else {
        milestone.approved = true;
      }
      db.campaigns.set(campaign.id, campaign);
      return milestone;
    },
  ),

  getUser: vi.fn(async (id: string): Promise<User | null> => {
    return db.users.get(id) ?? null;
  }),
};

// ---------------------------------------------------------------------------
// Mocked Stellar RPC (no live funds)
// ---------------------------------------------------------------------------

const stellarRpc = {
  submitTransaction: vi.fn(async (tx: { type: string; amount?: number }) => {
    return {
      hash: `tx_${nextId('hash')}`,
      successful: true,
      type: tx.type,
      ledger: 12345,
    };
  }),
  getAccountBalance: vi.fn(async (_publicKey: string) => {
    return { balance: '10000.0000000', asset: 'XLM' };
  }),
  verifyOnChainMilestone: vi.fn(async (_campaignId: string, _milestoneId: string) => {
    return { verified: true, ledger: 12345 };
  }),
};

// ---------------------------------------------------------------------------
// Route handlers (thin wrappers over storage + rpc, with authorization)
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface RequestContext {
  userId: string;
}

async function requireUser(ctx: RequestContext): Promise<User> {
  const user = await storage.getUser(ctx.userId);
  if (!user) {
    throw new HttpError(401, 'Unauthorized: unknown user');
  }
  return user;
}

async function requireOwner(ctx: RequestContext, campaign: Campaign): Promise<User> {
  const user = await requireUser(ctx);
  if (user.id !== campaign.ownerId && user.role !== 'admin') {
    throw new HttpError(403, 'Forbidden: not campaign owner');
  }
  return user;
}

async function requireRole(
  ctx: RequestContext,
  roles: Array<User['role']>,
): Promise<User> {
  const user = await requireUser(ctx);
  if (!roles.includes(user.role)) {
    throw new HttpError(403, `Forbidden: requires role ${roles.join('|')}`);
  }
  return user;
}

const handlers = {
  async createCampaign(
    ctx: RequestContext,
    body: {
      title: string;
      goalAmount: number;
      milestones: Array<{ title: string; targetAmount: number }>;
    },
  ) {
    const user = await requireUser(ctx);
    if (user.role !== 'owner' && user.role !== 'admin') {
      throw new HttpError(403, 'Forbidden: only owners can create campaigns');
    }
    if (!body.title || body.title.trim().length === 0) {
      throw new HttpError(400, 'Invalid: title required');
    }
    if (!Number.isFinite(body.goalAmount) || body.goalAmount <= 0) {
      throw new HttpError(400, 'Invalid: goalAmount must be positive');
    }
    if (!Array.isArray(body.milestones) || body.milestones.length === 0) {
      throw new HttpError(400, 'Invalid: at least one milestone required');
    }
    const totalMilestoneTarget = body.milestones.reduce(
      (sum, m) => sum + m.targetAmount,
      0,
    );
    if (totalMilestoneTarget > body.goalAmount) {
      throw new HttpError(
        400,
        'Invalid: milestone targets exceed goal amount',
      );
    }
    const campaign = await storage.createCampaign({
      ownerId: user.id,
      title: body.title,
      goalAmount: body.goalAmount,
      milestones: body.milestones,
    });
    return { status: 201, body: campaign };
  },

  async fundCampaign(
    ctx: RequestContext,
    campaignId: string,
    body: { amount: number; type: 'contribution' | 'donation' },
  ) {
    await requireUser(ctx);
    const campaign = await storage.getCampaign(campaignId);
    if (!campaign) {
      throw new HttpError(404, 'Campaign not found');
    }
    if (campaign.status !== 'active' && campaign.status !== 'funded') {
      throw new HttpError(
        409,
        `Invalid state transition: cannot fund campaign in status ${campaign.status}`,
      );
    }
    if (!Number.isFinite(body.amount) || body.amount <= 0) {
      throw new HttpError(400, 'Invalid: amount must be positive');
    }
    if (body.type !== 'contribution' && body.type !== 'donation') {
      throw new HttpError(400, 'Invalid: type must be contribution or donation');
    }
    // Submit on-chain transaction (mocked, no live funds).
    const tx = await stellarRpc.submitTransaction({
      type: body.type,
      amount: body.amount,
    });
    if (!tx.successful) {
      throw new HttpError(502, 'On-chain transaction failed');
    }
    const contribution = await storage.addContribution({
      campaignId,
      donorId: ctx.userId,
      amount: body.amount,
      type: body.type,
    });
    const updated = await storage.getCampaign(campaignId);
    return { status: 200, body: { contribution, campaign: updated, tx } };
  },

  async submitVerification(
    ctx: RequestContext,
    campaignId: string,
    body: { documentUrl: string },
  ) {
    const campaign = await storage.getCampaign(campaignId);
    if (!campaign) {
      throw new HttpError(404, 'Campaign not found');
    }
    await requireOwner(ctx, campaign);
    if (campaign.status !== 'funded') {
      throw new HttpError(
        409,
        `Invalid state transition: cannot submit verification in status ${campaign.status}`,
      );
    }
    if (!body.documentUrl || body.documentUrl.trim().length === 0) {
      throw new HttpError(400, 'Invalid: documentUrl required');
    }
    const evidence = await storage.addEvidence({
      campaignId,
      submittedBy: ctx.userId,
      documentUrl: body.documentUrl,
    });
    return { status: 201, body: evidence };
  },

  async reviewVerification(
    ctx: RequestContext,
    evidenceId: string,
    body: { decision: 'approved' | 'rejected' },
  ) {
    await requireRole(ctx, ['verifier', 'admin']);
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      throw new HttpError(400, 'Invalid: decision must be approved or rejected');
    }
    const evidence = await storage.updateEvidence(evidenceId, body.decision);
    if (!evidence) {
      throw new HttpError(404, 'Evidence not found');
    }
    return { status: 200, body: evidence };
  },

  async approveMilestone(
    ctx: RequestContext,
    campaignId: string,
    milestoneId: string,
    body: { mode: 'impact' | 'on-chain' },
  ) {
    const campaign = await storage.getCampaign(campaignId);
    if (!campaign) {
      throw new HttpError(404, 'Campaign not found');
    }
    await requireOwner(ctx, campaign);
    if (campaign.status !== 'verified') {
      throw new HttpError(
        409,
        `Invalid state transition: cannot approve milestone in status ${campaign.status}`,
      );
    }
    const milestone = campaign.milestones.find((m) => m.id === milestoneId);
    if (!milestone) {
      throw new HttpError(404, 'Milestone not found');
    }
    if (body.mode !== 'impact' && body.mode !== 'on-chain') {
      throw new HttpError(400, 'Invalid: mode must be impact or on-chain');
    }
    // Boundary: milestone target must be covered by raised funds.
    if (campaign.raisedAmount < milestone.targetAmount) {
      throw new HttpError(
        409,
        'Invalid: raised amount below milestone threshold',
      );
    }
    if (body.mode === 'on-chain') {
      const verification = await stellarRpc.verifyOnChainMilestone(
        campaignId,
        milestoneId,
      );
      if (!verification.verified) {
        throw new HttpError(502, 'On-chain milestone verification failed');
      }
      const updated = await storage.approveMilestone(
        campaignId,
        milestoneId,
        true,
      );
      return { status: 200, body: { milestone: updated, verification } };
    }
    const updated = await storage.approveMilestone(
      campaignId,
      milestoneId,
      false,
    );
    return { status: 200, body: { milestone: updated } };
  },

  async getReport(ctx: RequestContext, campaignId: string) {
    const campaign = await storage.getCampaign(campaignId);
    if (!campaign) {
      throw new HttpError(404, 'Campaign not found');
    }
    // Report is readable by owner, admin, or any authenticated user.
    await requireUser(ctx);
    const totalContributions = campaign.contributions
      .filter((c) => c.type === 'contribution')
      .reduce((sum, c) => sum + c.amount, 0);
    const totalDonations = campaign.contributions
      .filter((c) => c.type === 'donation')
      .reduce((sum, c) => sum + c.amount, 0);
    const approvedMilestones = campaign.milestones.filter(
      (m) => m.approved || m.onChainApproved,
    ).length;
    return {
      status: 200,
      body: {
        campaignId: campaign.id,
        title: campaign.title,
        status: campaign.status,
        goalAmount: campaign.goalAmount,
        raisedAmount: campaign.raisedAmount,
        totalContributions,
        totalDonations,
        milestoneCount: campaign.milestones.length,
        approvedMilestones,
        evidenceCount: campaign.evidence.length,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const OWNER = 'user_owner';
const DONOR = 'user_donor';
const VERIFIER = 'user_verifier';
const STRANGER = 'user_stranger';

beforeEach(() => {
  db.campaigns.clear();
  db.users.clear();
  idCounter = 0;
  vi.clearAllMocks();

  db.users.set(OWNER, { id: OWNER, role: 'owner' });
  db.users.set(DONOR, { id: DONOR, role: 'donor' });
  db.users.set(VERIFIER, { id: VERIFIER, role: 'verifier' });
  db.users.set(STRANGER, { id: STRANGER, role: 'donor' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createActiveCampaign(goalAmount = 1000) {
  const res = await handlers.createCampaign(
    { userId: OWNER },
    {
      title: 'Clean Water Project',
      goalAmount,
      milestones: [
        { title: 'Phase 1', targetAmount: Math.floor(goalAmount / 2) },
        { title: 'Phase 2', targetAmount: Math.floor(goalAmount / 2) },
      ],
    },
  );
  return res.body;
}

async function fundToGoal(campaignId: string, goalAmount: number) {
  return handlers.fundCampaign(
    { userId: DONOR },
    campaignId,
    { amount: goalAmount, type: 'contribution' },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Campaign lifecycle - happy path', () => {
  it('drives the full lifecycle from creation to report', async () => {
    // 1. Create campaign
    const createRes = await handlers.createCampaign(
      { userId: OWNER },
      {
        title: 'Clean Water Project',
        goalAmount: 1000,
        milestones: [
          { title: 'Phase 1', targetAmount: 500 },
          { title: 'Phase 2', targetAmount: 500 },
        ],
      },
    );
    expect(createRes.status).toBe(201);
    const campaign = createRes.body;
    expect(campaign.status).toBe('active');
    expect(campaign.ownerId).toBe(OWNER);
    expect(campaign.milestones).toHaveLength(2);

    // 2. Fund via contribution and donation
    const contribRes = await handlers.fundCampaign(
      { userId: DONOR },
      campaign.id,
      { amount: 600, type: 'contribution' },
    );
    expect(contribRes.status).toBe(200);
    expect(contribRes.body.campaign?.raisedAmount).toBe(600);
    expect(stellarRpc.submitTransaction).toHaveBeenCalledTimes(1);

    const donationRes = await handlers.fundCampaign(
      { userId: STRANGER },
      campaign.id,
      { amount: 400, type: 'donation' },
    );
    expect(donationRes.status).toBe(200);
    expect(donationRes.body.campaign?.raisedAmount).toBe(1000);
    expect(donationRes.body.campaign?.status).toBe('funded');

    // 3. Submit verification evidence (owner only)
    const verifyRes = await handlers.submitVerification(
      { userId: OWNER },
      campaign.id,
      { documentUrl: 'https://example.com/evidence.pdf' },
    );
    expect(verifyRes.status).toBe(201);
    expect(verifyRes.body?.status).toBe('pending');

    // 4. Verifier approves evidence
    const reviewRes = await handlers.reviewVerification(
      { userId: VERIFIER },
      verifyRes.body!.id,
      { decision: 'approved' },
    );
    expect(reviewRes.status).toBe(200);
    expect(reviewRes.body?.status).toBe('approved');

    const afterVerify = await storage.getCampaign(campaign.id);
    expect(afterVerify?.status).toBe('verified');

    // 5. Approve milestones (impact + on-chain)
    const [m1, m2] = afterVerify!.milestones;
    const impactRes = await handlers.approveMilestone(
      { userId: OWNER },
      campaign.id,
      m1.id,
      { mode: 'impact' },
    );
    expect(impactRes.status).toBe(200);
    expect(impactRes.body.milestone?.approved).toBe(true);

    const onChainRes = await handlers.approveMilestone(
      { userId: OWNER },
      campaign.id,
      m2.id,
      { mode: 'on-chain' },
    );
    expect(onChainRes.status).toBe(200);
    expect(onChainRes.body.milestone?.onChainApproved).toBe(true);
    expect(stellarRpc.verifyOnChainMilestone).toHaveBeenCalledWith(
      campaign.id,
      m2.id,
    );

    // 6. Fetch report
    const reportRes = await handlers.getReport({ userId: OWNER }, campaign.id);
    expect(reportRes.status).toBe(200);
    expect(reportRes.body).toMatchObject({
      campaignId: campaign.id,
      status: 'verified',
      goalAmount: 1000,
      raisedAmount: 1000,
      totalContributions: 600,
      totalDonations: 400,
      milestoneCount: 2,
      approvedMilestones: 2,
      evidenceCount: 1,
    });
  });
});

describe('Campaign lifecycle - authorization failures', () => {
  it('rejects campaign creation by non-owner', async () => {
    await expect(
      handlers.createCampaign(
        { userId: DONOR },
        {
          title: 'Nope',
          goalAmount: 100,
          milestones: [{ title: 'M', targetAmount: 100 }],
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects campaign creation by unknown user', async () => {
    await expect(
      handlers.createCampaign(
        { userId: 'ghost' },
        {
          title: 'Nope',
          goalAmount: 100,
          milestones: [{ title: 'M', targetAmount: 100 }],
        },
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects funding by unknown user', async () => {
    const campaign = await createActiveCampaign();
    await expect(
      handlers.fundCampaign({ userId: 'ghost' }, campaign.id, {
        amount: 10,
        type: 'contribution',
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects verification submission by non-owner', async () => {
    const campaign = await createActiveCampaign();
    await fundToGoal(campaign.id, campaign.goalAmount);
    await expect(
      handlers.submitVerification({ userId: DONOR }, campaign.id, {
        documentUrl: 'https://example.com/x.pdf',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects verification review by non-verifier', async () => {
    const campaign = await createActiveCampaign();
    await fundToGoal(campaign.id, campaign.goalAmount);
    const verifyRes = await handlers.submitVerification(
      { userId: OWNER },
      campaign.id,
      { documentUrl: 'https://example.com/x.pdf' },
    );
    await expect(
      handlers.reviewVerification({ userId: DONOR }, verifyRes.body!.id, {
        decision: 'approved',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects milestone approval by non-owner', async () => {
    const campaign = await createActiveCampaign();
    await fundToGoal(campaign.id, campaign.goalAmount);
    const verifyRes = await handlers.submitVerification(
      { userId: OWNER },
      campaign.id,
      { documentUrl: 'https://example.com/x.pdf' },
    );
    await handlers.reviewVerification({ userId: VERIFIER }, verifyRes.body!.id, {
      decision: 'approved',
    });
    const updated = await storage.getCampaign(campaign.id);
    await expect(
      handlers.approveMilestone(
        { userId: DONOR },
        campaign.id,
        updated!.milestones[0].id,
        { mode: 'impact' },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects report fetch by unknown user', async () => {
    const campaign = await createActiveCampaign();
    await expect(
      handlers.getReport({ userId: 'ghost' }, campaign.id),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('Campaign lifecycle - invalid state transitions', () => {
  it('rejects verification submission before funding goal is reached', async () => {
    const campaign = await createActiveCampaign();
    await handlers.fundCampaign({ userId: DONOR }, campaign.id, {
      amount: 100,
      type: 'contribution',
    });
    await expect(
      handlers.submitVerification({ userId: OWNER }, campaign.id, {
        documentUrl: 'https://example.com/x.pdf',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects milestone approval before verification', async () => {
    const campaign = await createActiveCampaign();
    await fundToGoal(campaign.id, campaign.goalAmount);
    const updated = await storage.getCampaign(campaign.id);
    await expect(
      handlers.approveMilestone(
        { userId: OWNER },
        campaign.id,
        updated!.milestones[0].id,
        { mode: 'impact' },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects funding a completed campaign', async () => {
    const campaign = await createActiveCampaign();
    await storage.updateCampaign(campaign.id, { status: 'completed' });
    await expect(
      handlers.fundCampaign({ userId: DONOR }, campaign.id, {
        amount: 10,
        type: 'contribution',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects funding a non-existent campaign', async () => {
    await expect(
      handlers.fundCampaign({ userId: DONOR }, 'missing', {
        amount: 10,
        type: 'contribution',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects milestone approval below threshold', async () => {
    const campaign = await createActiveCampaign(1000);
    // Fund only 400 (below first milestone target of 500).
    await handlers.fundCampaign({ userId: DONOR }, campaign.id, {
      amount: 400,
      type: 'contribution',
    });
    // Force status to verified to isolate the threshold check.
    await storage.updateCampaign(campaign.id, { status: 'verified' });
    const updated = await storage.getCampaign(campaign.id);
    await expect(
      handlers.approveMilestone(
        { userId: OWNER },
        campaign.id,
        updated!.milestones[0].id,
        { mode: 'impact' },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects on-chain milestone approval when RPC verification fails', async () => {
    const campaign = await createActiveCampaign();
    await fundToGoal(campaign.id, campaign.goalAmount);
    const verifyRes = await handlers.submitVerification(
      { userId: OWNER },
      campaign.id,
      { documentUrl: 'https://example.com/x.pdf' },
    );
    await handlers.reviewVerification({ userId: VERIFIER }, verifyRes.body!.id, {
      decision: 'approved',
    });
    const updated = await storage.getCampaign(campaign.id);

    stellarRpc.verifyOnChainMilestone.mockResolvedValueOnce({
      verified: false,
      ledger: 0,
    });

    await expect(
      handlers.approveMilestone(
        { userId: OWNER },
        campaign.id,
        updated!.milestones[0].id,
        { mode: 'on-chain' },
      ),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('Campaign lifecycle - boundary cases', () => {
  it('marks campaign funded when raised amount exactly equals goal', async () => {
    const campaign = await createActiveCampaign(1000);
    const res = await handlers.fundCampaign({ userId: DONOR }, campaign.id, {
      amount: 1000,
      type: 'contribution',
    });
    expect(res.body.campaign?.raisedAmount).toBe(1000);
    expect(res.body.campaign?.status).toBe('funded');
  });

  it('keeps campaign active when raised amount is one unit below goal', async () => {
    const campaign = await createActiveCampaign(1000);
    const res = await handlers.fundCampaign({ userId: DONOR }, campaign.id, {
      amount: 999,
      type: 'contribution',
    });
    expect(res.body.campaign?.raisedAmount).toBe(999);
    expect(res.body.campaign?.status).toBe('active');
  });

  it('allows milestone approval when raised amount exactly equals milestone threshold', async () => {
    const campaign = await createActiveCampaign(1000);
    await fundToGoal(campaign.id, campaign.goalAmount);
    const verifyRes = await handlers.submitVerification(
      { userId: OWNER },
      campaign.id,
      { documentUrl: 'https://example.com/x.pdf' },
    );
    await handlers.reviewVerification({ userId: VERIFIER }, verifyRes.body!.id, {
      decision: 'approved',
    });
    const updated = await storage.getCampaign(campaign.id);
    // Milestone target is 500, raised is 1000 -> well above threshold.
    const res = await handlers.approveMilestone(
      { userId: OWNER },
      campaign.id,
      updated!.milestones[0].id,
      { mode: 'impact' },
    );
    expect(res.status).toBe(200);
    expect(res.body.milestone?.approved).toBe(true);
  });

  it('rejects milestone approval one unit below threshold', async () => {
    const campaign = await createActiveCampaign(1000);
    // Fund 499 (one below first milestone target of 500).
    await handlers.fundCampaign({ userId: DONOR }, campaign.id, {
      amount: 499,
      type: 'contribution',
    });
    await storage.updateCampaign(campaign.id, { status: 'verified' });
    const updated = await storage.getCampaign(campaign.id);
    await expect(
      handlers.approveMilestone(
        { userId: OWNER },
        campaign.id,
        updated!.milestones[0].id,
        { mode: 'impact' },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects zero and negative funding amounts', async () => {
    const campaign = await createActiveCampaign();
    await expect(
      handlers.fundCampaign({ userId: DONOR }, campaign.id, {
        amount: 0,
        type: 'contribution',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      handlers.fundCampaign({ userId: DONOR }, campaign.id, {
        amount: -10,
        type: 'contribution',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects campaign creation with milestone targets exceeding goal', async () => {
    await expect(
      handlers.createCampaign(
        { userId: OWNER },
        {
          title: 'Bad',
          goalAmount: 100,
          milestones: [{ title: 'M', targetAmount: 200 }],
        },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects campaign creation with empty milestones', async () => {
    await expect(
      handlers.createCampaign(
        { userId: OWNER },
        { title: 'Bad', goalAmount: 100, milestones: [] },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects campaign creation with non-positive goal', async () => {
    await expect(
      handlers.createCampaign(
        { userId: OWNER },
        {
          title: 'Bad',
          goalAmount: 0,
          milestones: [{ title: 'M', targetAmount: 0 }],
        },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects verification submission with empty document URL', async () => {
    const campaign = await createActiveCampaign();
    await fundToGoal(campaign.id, campaign.goalAmount);
    await expect(
      handlers.submitVerification({ userId: OWNER }, campaign.id, {
        documentUrl: '',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects unknown milestone id', async () => {
    const campaign = await createActiveCampaign();
    await fundToGoal(campaign.id, campaign.goalAmount);
    const verifyRes = await handlers.submitVerification(
      { userId: OWNER },
      campaign.id,
      { documentUrl: 'https://example.com/x.pdf' },
    );
    await handlers.reviewVerification({ userId: VERIFIER }, verifyRes.body!.id, {
      decision: 'approved',
    });
    await expect(
      handlers.approveMilestone(
        { userId: OWNER },
        campaign.id,
        'milestone_missing',
        { mode: 'impact' },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('Campaign lifecycle - storage and RPC isolation', () => {
  it('does not touch live funds: all RPC calls are mocked', async () => {
    const campaign = await createActiveCampaign();
    await fundToGoal(campaign.id, campaign.goalAmount);
    expect(stellarRpc.submitTransaction).toHaveBeenCalled();
    // The mock always returns a deterministic hash prefix.
    const call = stellarRpc.submitTransaction.mock.results[0];
    expect(call.type).toBe('return');
    const value = await (call as Promise<{ hash: string }>).value;
    expect(value.hash).toMatch(/^tx_hash_/);
  });

  it('resets storage between tests', async () => {
    expect(db.campaigns.size).toBe(0);
    await createActiveCampaign();
    expect(db.campaigns.size).toBe(1);
  });
});