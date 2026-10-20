/**
 * Deterministic E2E fixtures for critical fundraising journeys.
 *
 * These fixtures are intentionally free of live funds and network calls.
 * They provide:
 *  - Seeded campaigns (discovery)
 *  - A mocked wallet provider (connect / disconnect / accounts / chain)
 *  - A stubbed RPC layer (balances, receipts, verification state)
 *  - Verification evidence records
 *  - Receipt records
 *
 * All identifiers, amounts, and timestamps are fixed so specs remain
 * deterministic and independent of any external state.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type CampaignStatus = 'draft' | 'active' | 'funded' | 'closed';

export interface SeededCampaign {
  id: string;
  slug: string;
  title: string;
  summary: string;
  creatorAddress: string;
  beneficiaryAddress: string;
  asset: 'USDC' | 'ETH';
  goalAmount: string; // decimal string, base units are derived below
  raisedAmount: string; // decimal string
  contributorCount: number;
  status: CampaignStatus;
  createdAt: string; // ISO 8601, fixed
  endsAt: string; // ISO 8601, fixed
  verificationId: string;
  tags: string[];
}

export interface MockWalletAccount {
  address: string;
  label: string;
  balance: string; // decimal string in native asset
}

export interface MockWalletProvider {
  id: string;
  name: string;
  chainId: number;
  chainName: string;
  accounts: MockWalletAccount[];
  /** Default account used when a spec connects without specifying one. */
  defaultAccount: string;
  /** Whether the provider is "installed" in the simulated window. */
  installed: boolean;
}

export interface StubbedRpcBalance {
  address: string;
  asset: 'USDC' | 'ETH';
  amount: string; // decimal string
}

export interface VerificationEvidence {
  id: string;
  campaignId: string;
  status: 'pending' | 'verified' | 'rejected';
  reviewer: string;
  reviewedAt: string; // ISO 8601, fixed
  documents: Array<{
    id: string;
    kind: 'registration' | 'bank_statement' | 'tax_filing' | 'identity';
    fileName: string;
    checksum: string;
  }>;
  notes: string;
}

export interface Receipt {
  id: string;
  campaignId: string;
  contributorAddress: string;
  amount: string; // decimal string
  asset: 'USDC' | 'ETH';
  txHash: string;
  blockNumber: number;
  timestamp: string; // ISO 8601, fixed
  status: 'confirmed' | 'pending' | 'failed';
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Fixed clock used across all fixtures so timestamps never drift. */
export const FIXED_NOW = '2024-06-01T12:00:00.000Z';

/** Deterministic chain used by the mocked wallet + stubbed RPC. */
export const MOCK_CHAIN = {
  id: 31337,
  name: 'Local Test Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
} as const;

/** Well-known deterministic addresses (not derived from any real key). */
export const ADDRESSES = {
  creator: '0x1111111111111111111111111111111111111111',
  beneficiary: '0x2222222222222222222222222222222222222222',
  contributorPrimary: '0x3333333333333333333333333333333333333333',
  contributorSecondary: '0x4444444444444444444444444444444444444444',
  contributorEmpty: '0x5555555555555555555555555555555555555555',
  reviewer: '0x6666666666666666666666666666666666666666',
} as const;

/* -------------------------------------------------------------------------- */
/* Seeded campaigns                                                           */
/* -------------------------------------------------------------------------- */

export const SEEDED_CAMPAIGNS: SeededCampaign[] = [
  {
    id: 'camp_0001',
    slug: 'clean-water-initiative',
    title: 'Clean Water Initiative',
    summary: 'Bringing safe drinking water to three rural districts.',
    creatorAddress: ADDRESSES.creator,
    beneficiaryAddress: ADDRESSES.beneficiary,
    asset: 'USDC',
    goalAmount: '50000.00',
    raisedAmount: '12500.00',
    contributorCount: 42,
    status: 'active',
    createdAt: '2024-05-01T09:00:00.000Z',
    endsAt: '2024-08-01T09:00:00.000Z',
    verificationId: 'ver_0001',
    tags: ['water', 'health', 'rural'],
  },
  {
    id: 'camp_0002',
    slug: 'open-source-education',
    title: 'Open Source Education Kits',
    summary: 'Free curriculum kits for under-resourced classrooms.',
    creatorAddress: ADDRESSES.creator,
    beneficiaryAddress: ADDRESSES.beneficiary,
    asset: 'USDC',
    goalAmount: '20000.00',
    raisedAmount: '20000.00',
    contributorCount: 118,
    status: 'funded',
    createdAt: '2024-03-15T10:30:00.000Z',
    endsAt: '2024-06-15T10:30:00.000Z',
    verificationId: 'ver_0002',
    tags: ['education', 'open-source'],
  },
  {
    id: 'camp_0003',
    slug: 'community-solar',
    title: 'Community Solar Co-op',
    summary: 'Shared solar array for a neighborhood microgrid.',
    creatorAddress: ADDRESSES.creator,
    beneficiaryAddress: ADDRESSES.beneficiary,
    asset: 'ETH',
    goalAmount: '15.00',
    raisedAmount: '3.25',
    contributorCount: 9,
    status: 'active',
    createdAt: '2024-05-20T08:00:00.000Z',
    endsAt: '2024-09-20T08:00:00.000Z',
    verificationId: 'ver_0003',
    tags: ['energy', 'climate'],
  },
  {
    id: 'camp_0004',
    slug: 'draft-pending-review',
    title: 'Draft: Pending Review Campaign',
    summary: 'A campaign still awaiting verification.',
    creatorAddress: ADDRESSES.creator,
    beneficiaryAddress: ADDRESSES.beneficiary,
    asset: 'USDC',
    goalAmount: '1000.00',
    raisedAmount: '0.00',
    contributorCount: 0,
    status: 'draft',
    createdAt: '2024-05-28T14:00:00.000Z',
    endsAt: '2024-07-28T14:00:00.000Z',
    verificationId: 'ver_0004',
    tags: ['draft'],
  },
];

/** Convenience lookup by slug for specs. */
export function findCampaignBySlug(slug: string): SeededCampaign | undefined {
  return SEEDED_CAMPAIGNS.find((c) => c.slug === slug);
}

/** Convenience lookup by id for specs. */
export function findCampaignById(id: string): SeededCampaign | undefined {
  return SEEDED_CAMPAIGNS.find((c) => c.id === id);
}

/* -------------------------------------------------------------------------- */
/* Mocked wallet provider                                                     */
/* -------------------------------------------------------------------------- */

export const MOCK_WALLET_PROVIDER: MockWalletProvider = {
  id: 'mock-wallet',
  name: 'Mock Wallet',
  chainId: MOCK_CHAIN.id,
  chainName: MOCK_CHAIN.name,
  installed: true,
  defaultAccount: ADDRESSES.contributorPrimary,
  accounts: [
    {
      address: ADDRESSES.contributorPrimary,
      label: 'Primary Contributor',
      balance: '1000.00',
    },
    {
      address: ADDRESSES.contributorSecondary,
      label: 'Secondary Contributor',
      balance: '250.00',
    },
    {
      address: ADDRESSES.contributorEmpty,
      label: 'Empty Contributor',
      balance: '0.00',
    },
  ],
};

/** A provider variant representing "wallet not installed". */
export const MOCK_WALLET_PROVIDER_MISSING: MockWalletProvider = {
  ...MOCK_WALLET_PROVIDER,
  installed: false,
  accounts: [],
  defaultAccount: '',
};

/** A provider variant representing a wrong-chain connection. */
export const MOCK_WALLET_PROVIDER_WRONG_CHAIN: MockWalletProvider = {
  ...MOCK_WALLET_PROVIDER,
  chainId: 1,
  chainName: 'Ethereum Mainnet',
};

/* -------------------------------------------------------------------------- */
/* Stubbed RPC balances                                                       */
/* -------------------------------------------------------------------------- */

export const STUBBED_RPC_BALANCES: StubbedRpcBalance[] = [
  {
    address: ADDRESSES.contributorPrimary,
    asset: 'USDC',
    amount: '1000.00',
  },
  {
    address: ADDRESSES.contributorPrimary,
    asset: 'ETH',
    amount: '2.50',
  },
  {
    address: ADDRESSES.contributorSecondary,
    asset: 'USDC',
    amount: '250.00',
  },
  {
    address: ADDRESSES.contributorSecondary,
    asset: 'ETH',
    amount: '0.10',
  },
  {
    address: ADDRESSES.contributorEmpty,
    asset: 'USDC',
    amount: '0.00',
  },
  {
    address: ADDRESSES.contributorEmpty,
    asset: 'ETH',
    amount: '0.00',
  },
];

/** Look up a stubbed balance; returns '0.00' when unknown. */
export function getStubbedBalance(
  address: string,
  asset: 'USDC' | 'ETH',
): string {
  const match = STUBBED_RPC_BALANCES.find(
    (b) => b.address.toLowerCase() === address.toLowerCase() && b.asset === asset,
  );
  return match ? match.amount : '0.00';
}

/* -------------------------------------------------------------------------- */
/* Verification evidence                                                      */
/* -------------------------------------------------------------------------- */

export const VERIFICATION_EVIDENCE: VerificationEvidence[] = [
  {
    id: 'ver_0001',
    campaignId: 'camp_0001',
    status: 'verified',
    reviewer: ADDRESSES.reviewer,
    reviewedAt: '2024-05-02T10:00:00.000Z',
    documents: [
      {
        id: 'doc_0001',
        kind: 'registration',
        fileName: 'water-initiative-registration.pdf',
        checksum: 'sha256:aaaa0001',
      },
      {
        id: 'doc_0002',
        kind: 'bank_statement',
        fileName: 'water-initiative-bank-statement.pdf',
        checksum: 'sha256:aaaa0002',
      },
    ],
    notes: 'Registration and bank statement verified.',
  },
  {
    id: 'ver_0002',
    campaignId: 'camp_0002',
    status: 'verified',
    reviewer: ADDRESSES.reviewer,
    reviewedAt: '2024-03-16T11:00:00.000Z',
    documents: [
      {
        id: 'doc_0003',
        kind: 'registration',
        fileName: 'education-kits-registration.pdf',
        checksum: 'sha256:bbbb0001',
      },
    ],
    notes: 'Nonprofit registration confirmed.',
  },
  {
    id: 'ver_0003',
    campaignId: 'camp_0003',
    status: 'pending',
    reviewer: ADDRESSES.reviewer,
    reviewedAt: '2024-05-21T09:00:00.000Z',
    documents: [
      {
        id: 'doc_0004',
        kind: 'tax_filing',
        fileName: 'solar-coop-tax-filing.pdf',
        checksum: 'sha256:cccc0001',
      },
    ],
    notes: 'Awaiting secondary review of tax filing.',
  },
  {
    id: 'ver_0004',
    campaignId: 'camp_0004',
    status: 'rejected',
    reviewer: ADDRESSES.reviewer,
    reviewedAt: '2024-05-29T15:00:00.000Z',
    documents: [
      {
        id: 'doc_0005',
        kind: 'identity',
        fileName: 'draft-identity.pdf',
        checksum: 'sha256:dddd0001',
      },
    ],
    notes: 'Identity document was unreadable; resubmission required.',
  },
];

/** Look up verification evidence by campaign id. */
export function findVerificationByCampaignId(
  campaignId: string,
): VerificationEvidence | undefined {
  return VERIFICATION_EVIDENCE.find((v) => v.campaignId === campaignId);
}

/* -------------------------------------------------------------------------- */
/* Receipts                                                                   */
/* -------------------------------------------------------------------------- */

export const RECEIPTS: Receipt[] = [
  {
    id: 'rcpt_0001',
    campaignId: 'camp_0001',
    contributorAddress: ADDRESSES.contributorPrimary,
    amount: '100.00',
    asset: 'USDC',
    txHash:
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    blockNumber: 1001,
    timestamp: '2024-05-10T12:00:00.000Z',
    status: 'confirmed',
  },
  {
    id: 'rcpt_0002',
    campaignId: 'camp_0001',
    contributorAddress: ADDRESSES.contributorSecondary,
    amount: '50.00',
    asset: 'USDC',
    txHash:
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    blockNumber: 1002,
    timestamp: '2024-05-11T13:30:00.000Z',
    status: 'confirmed',
  },
  {
    id: 'rcpt_0003',
    campaignId: 'camp_0003',
    contributorAddress: ADDRESSES.contributorPrimary,
    amount: '0.50',
    asset: 'ETH',
    txHash:
      '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    blockNumber: 1003,
    timestamp: '2024-05-22T09:15:00.000Z',
    status: 'pending',
  },
  {
    id: 'rcpt_0004',
    campaignId: 'camp_0002',
    contributorAddress: ADDRESSES.contributorSecondary,
    amount: '25.00',
    asset: 'USDC',
    txHash:
      '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    blockNumber: 1004,
    timestamp: '2024-04-01T16:45:00.000Z',
    status: 'failed',
  },
];

/** Look up receipts for a campaign. */
export function findReceiptsByCampaignId(campaignId: string): Receipt[] {
  return RECEIPTS.filter((r) => r.campaignId === campaignId);
}

/** Look up receipts for a contributor. */
export function findReceiptsByContributor(address: string): Receipt[] {
  return RECEIPTS.filter(
    (r) => r.contributorAddress.toLowerCase() === address.toLowerCase(),
  );
}

/* -------------------------------------------------------------------------- */
/* Contribution preparation fixtures                                          */
/* -------------------------------------------------------------------------- */

export interface ContributionDraft {
  campaignId: string;
  contributorAddress: string;
  amount: string;
  asset: 'USDC' | 'ETH';
  /** Whether the draft is expected to pass client-side validation. */
  valid: boolean;
  /** Reason the draft is invalid, when applicable. */
  invalidReason?: 'insufficient_balance' | 'below_minimum' | 'above_maximum';
}

export const CONTRIBUTION_DRAFTS: ContributionDraft[] = [
  {
    campaignId: 'camp_0001',
    contributorAddress: ADDRESSES.contributorPrimary,
    amount: '100.00',
    asset: 'USDC',
    valid: true,
  },
  {
    campaignId: 'camp_0001',
    contributorAddress: ADDRESSES.contributorEmpty,
    amount: '100.00',
    asset: 'USDC',
    valid: false,
    invalidReason: 'insufficient_balance',
  },
  {
    campaignId: 'camp_0001',
    contributorAddress: ADDRESSES.contributorPrimary,
    amount: '0.00',
    asset: 'USDC',
    valid: false,
    invalidReason: 'below_minimum',
  },
  {
    campaignId: 'camp_0003',
    contributorAddress: ADDRESSES.contributorPrimary,
    amount: '0.50',
    asset: 'ETH',
    valid: true,
  },
];

/* -------------------------------------------------------------------------- */
/* Aggregate fixture bundle                                                   */
/* -------------------------------------------------------------------------- */

export const FUNDRAISING_FIXTURES = {
  now: FIXED_NOW,
  chain: MOCK_CHAIN,
  addresses: ADDRESSES,
  campaigns: SEEDED_CAMPAIGNS,
  wallet: MOCK_WALLET_PROVIDER,
  walletMissing: MOCK_WALLET_PROVIDER_MISSING,
  walletWrongChain: MOCK_WALLET_PROVIDER_WRONG_CHAIN,
  balances: STUBBED_RPC_BALANCES,
  verification: VERIFICATION_EVIDENCE,
  receipts: RECEIPTS,
  contributionDrafts: CONTRIBUTION_DRAFTS,
} as const;

export type FundraisingFixtures = typeof FUNDRAISING_FIXTURES;