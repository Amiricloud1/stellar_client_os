/**
 * GraphQL Schema — Aggregate Funding Analytics Gateway (issue #538)
 *
 * Exposes aggregate payment stream metrics queryable by region, category,
 * and asset (token). All monetary amounts are returned as strings to avoid
 * JavaScript BigInt serialisation issues.
 *
 * Query safety (issue #60): the schema is served with depth-limit and
 * complexity-limit validation rules plus a per-request execution timeout.
 * See `./limits` for the exported rules, budgets, and timeout helper.
 *
 * Operational surfaces (issues #218–#222):
 *   - `contractDeployments` / `contractDeployment` — validated deployment
 *     registry (network, address, ledger, spec version, lifecycle state).
 *   - `contractEventMappings` — canonical event-version → projection mappings;
 *     unknown versions are retained with `known: false`.
 *   - `projectionReplays` — replay runs across event-schema versions; cutover
 *     is blocked unless the run is MATCHED.
 *   - `consumerQueueMetrics` — bounded-queue/concurrency metrics; consumers
 *     apply backpressure and never drop events (`droppedCount` is always 0).
 *
 * Compatibility: all additions are additive. Existing queries (`contracts`,
 * `campaigns`, etc.) are unchanged, so no migration is required for current
 * clients. New fields are nullable or list-returning so partial rollouts are
 * safe; operators should treat `FAILED`/`MISMATCH`/`degraded` states as
 * actionable alerts rather than transient errors.
 */

import type { GraphQLSchema } from 'graphql';
import {
  DEFAULT_QUERY_LIMITS,
  createDepthLimitRule,
  createComplexityLimitRule,
  withExecutionTimeout,
  type QueryLimits,
} from './limits';

export const typeDefs = /* GraphQL */`
  """Supported Stellar network."""
  enum Network {
    testnet
    mainnet
  }

  """Status of a payment stream."""
  enum StreamStatus {
    Active
    Paused
    Canceled
    Completed
  }

  """
  Leaderboard bucket for a sponsor based on their impact percentile
  (e.g. 'top_10' means the sponsor ranks in the top 10% of all sponsors).
  """
  enum RankingBand {
    top_1
    top_5
    top_10
    top_25
    top_50
    below_average
  }

  """Aggregated metrics for a single asset (token)."""
  type AssetMetrics {
    """Token contract address (C‚ Stellar address)."""
    asset: String!
    """Human-readable ticker symbol if known, otherwise the asset address."""
    symbol: String!
    """Total volume streamed in the asset's stroops (as string)."""
    totalVolume: String!
    """Number of individual payment streams using this asset."""
    streamCount: Int!
    """Number of unique sender addresses."""
    uniqueSenders: Int!
    """Number of unique recipient addresses."""
    uniqueRecipients: Int!
    """Average stream amount in stroops (as string)."""
    averageStreamAmount: String!
  }

  """Aggregated metrics for a geographic region."""
  type RegionMetrics {
    """ISO 3166-1 alpha-2 region code (e.g. 'NG', 'GH') or 'GLOBAL'."""
    region: String!
    """Total number of streams in this region."""
    totalStreams: Int!
    """Total volume across all assets (normalised to USDC-equivalent, as string)."""
    totalVolumeUsd: String!
    """Number of unique funded projects in this region."""
    projectCount: Int!
    """Per-asset breakdown."""
    assetBreakdown: [AssetMetrics!]!
  }

  """Aggregated metrics for a funding category."""
  type CategoryMetrics {
    """Category label (e.g. 'climate', 'education', 'health')."""
    category: String!
    """Total number of streams in this category."""
    totalStreams: Int!
    """Total volume in USDC-equivalent (as string)."""
    totalVolumeUsd: String!
    """Percentage of all streams that fall into this category (0–100)."""
    sharePercent: Float!
    """Per-asset breakdown within this category."""
    assetBreakdown: [AssetMetrics!]!
  }

  """
  A single sponsor's impact compared with the global average sponsor.
  CO2 figures are estimates derived from funded volume (see co2PerUsdKg).
  """
  type SponsorImpact {
    """The sponsor's Stellar address."""
    address: String!
    """Total volume funded by this sponsor (USDC-equivalent, as string)."""
    myVolumeUsd: String!
    """Estimated CO2 offset from this sponsor's funding (kg CO2e)."""
    myCo2OffsetKg: Float!
    """Average volume funded per sponsor (USDC-equivalent, as string)."""
    globalAverageVolumeUsd: String!
    """Estimated CO2 offset of the average sponsor (kg CO2e)."""
    globalAverageCo2OffsetKg: Float!
    """Number of unique sponsors (senders) in the dataset."""
    globalSponsorCount: Int!
    """
    Percentage of sponsors this sponsor beats (0–100).
    Null when there is no sponsor data to compare against.
    """
    percentile: Int
    """Ranking band (e.g. top_10). Null when there is no data."""
    rankingBand: RankingBand
    """CO2 conversion factor applied (kg CO2e per 1 USD funded)."""
    co2PerUsdKg: Float!
  }

  """Top-level aggregate across all streams."""
  type GlobalMetrics {
    """Total number of streams ever created."""
    totalStreams: Int!
    """Total active streams right now."""
    activeStreams: Int!
    """Total volume across all assets and regions (USDC-equivalent, as string)."""
    totalVolumeUsd: String!
    """Number of distinct asset types used."""
    uniquEbassets: Int!
    """Number of distinct regions represented."""
    uniqueRegions: Int!
    """Number of distinct categories represented."""
    uniqueCategories: Int!
    """Unix timestamp (seconds) of the most recently created stream."""
    latestStreamAt: Int
  }

  """
  Pagination arguments shared by all list queries (issue #59).

  Ordering is stable: results are always sorted by the query's default sort
  key with a unique tiebreaker (id) so pages never overlap or skip items.
  """
  input PaginationInput {
    """
    Maximum number of items to return. Defaults to 20 and is capped at 100;
    values above the cap are clamped to 100, values below 1 are rejected.
    """
    limit: Int
    """Zero-based offset for the result set (default 0)."""
    offset: Int
  }

  """Sort direction shared by all list queries."""
  enum SortDirection {
    ASC
    DESC
  }

  """
  Generic sort input shared by all list queries (issue #59).

  When `field` is omitted the query's documented default sort field is used.
  When `direction` is omitted it defaults to DESC. A unique tiebreaker is
  always applied so ordering is deterministic across pages.
  """
  input SortInput {
    """Field to sort by. Omit to use the query's default sort field."""
    field: String
    """Sort direction (default DESC)."""
    direction: SortDirection
  }

  """Shared pagination metadata returned alongside every list result."""
  type PageInfo {
    """Number of items requested after clamping (default 20, max 100)."""
    limit: Int!
    """Offset applied to the result set."""
    offset: Int!
    """Total number of items matching the filter, ignoring pagination."""
    totalCount: Int!
    """Whether more items exist after this page."""
    hasNextPage: Boolean!
    """Whether items exist before this page."""
    hasPreviousPage: Boolean!
    """Sort field actually applied (after defaulting)."""
    sortField: String!
    """Sort direction actually applied (after defaulting)."""
    sortDirection: SortDirection!
  }

  """Filter arguments for region metrics."""
  input RegionFilter {
    """Return only this region (ISO 3166-1 alpha-2)  Omit for all regions."""
    region: String
    """Return only streams for this asset address. Omit for all assets."""
    asset: String
    """Return only streams matching this status. Omit for all statuses."""
    status: StreamStatus
    """Return streams created at or after this Unix timestamp (seconds)."""
    fromTimestamp: Int
    """Return streams created at or before this Unix timestamp (seconds)."""
    toTimestamp: Int
  }

  """Filter arguments for category metrics."""
  input CategoryFilter {
    """Return only this category. Omit for all categories."""
    category: String
    """Return only streams for this asset address. Omit for all assets."""
    asset: String
    """Return only streams matching this status. Omit for all statuses."""
    status: StreamStatus
  }

  """Filter arguments for asset metrics."""
  input AssetFilter {
    """Return only this asset address. Omit for all assets."""
    asset: String
    """Return only streams matching this status. Omit for all statuses."""
    status: StreamStatus
    """Return streams created at or after this Unix timestamp (seconds)."""
    fromTimestamp: Int
    """Return streams created at or before this Unix timestamp (seconds)."""
    toTimestamp: Int
  }

  """Sort options for the Planter job board."""
  enum JobSort {
    """Sort by highest pay rate first."""
    PAY_HIGHEST
    """Sort by soonest deadline first."""
    DEADLINE_SOONEST
    """Sort by easiest (lowest altitude) first."""
    ALTITUDE_LOWEST
  }

  """A job posting on the Planter job board."""
  type Job {
    """Unique job identifier."""
    id: ID!
    """Job title."""
    title: String!
    """Pay rate (as string to avoid floating point issues)."""
    payRate: String!
    """Unix timestamp (seconds) of application deadline."""
    deadline: Int!
    """Altitude of the job site in metres above sea level (lower is easier)."""
    altitude: Float!
  }

  enum CampaignStatus {
    DRAFT
    PENDING_VERIFICATION
    ACTIVE
    PAUSED
    COMPLETED
    FAILED
  }

  enum CampaignSortField {
    createdAt
    updatedAt
    name
    status
    goalAmount
    raisedAmount
    sponsorCount
    treeCount
  }

  input CampaignFilter {
    status: CampaignStatus
    creator: String
    search: String
    minGoalAmount: String
    maxGoalAmount: String
    createdAfter: Int
    createdBefore: Int
  }

  input CampaignSort {
    field: CampaignSortField
    direction: SortDirection
  }

  type CampaignSponsor {
    id: ID!
    campaignId: ID!
    address: String!
    amount: String!
    token: String!
    sponsoredAt: Int!
  }

  """
  Immutable snapshot of the donor-facing terms shown before a contribution was
  signed (issue #176).

  The snapshot is captured at contribution time and bound to the contribution
  by `contentHash`. Clients should display `terms` and recompute the hash to
  verify it matches `contentHash` before signing.
  """
  type TermsSnapshot {
    """Monotonic version of the terms document that was shown."""
    version: Int!
    """The exact donor-facing terms text shown before signing."""
    terms: String!
    """
    SHA-256 (hex) content hash of `terms`. Bound to the contribution so the
    displayed terms can be verified after the fact.
    """
    contentHash: String!
    """Unix timestamp (seconds) when the snapshot was captured."""
    capturedAt: Int!
  }

  """
  A contribution (donation) bound to the terms snapshot shown before signing
  (issue #176).
  """
  type CampaignDonation {
    id: ID!
    campaignId: ID!
    donor: String!
    amount: String!
    token: String!
    createdAt: Int!
    """The terms snapshot captured when this contribution was signed."""
    termsSnapshot: TermsSnapshot!
    """Convenience accessor for `termsSnapshot.contentHash`."""
    termsSnapshotHash: String!
    """Convenience accessor for `termsSnapshot.version`."""
    termsVersion: Int!
  }

  """
  Receipt for a contribution, including the terms snapshot it was bound to
  (issue #176). Receipts remain verifiable even if the current terms change.
  """
  type DonationReceipt {
    id: ID!
    donationId: ID!
    campaignId: ID!
    donor: String!
    amount: String!
    token: String!
    issuedAt: Int!
    """The terms snapshot bound to the underlying contribution."""
    termsSnapshot: TermsSnapshot!
    """Convenience accessor for `termsSnapshot.contentHash`."""
    termsSnapshotHash: String!
    """Convenience accessor for `termsSnapshot.version`."""
    termsVersion: Int!
  }

  """
  Resolution status of a reviewer comment (issue #178).
  """
  enum ReviewerCommentStatus {
    """Comment is open and awaiting resolution."""
    OPEN
    """Comment has been resolved by a reviewer."""
    RESOLVED
  }

  """
  A reviewer comment attached to a specific evidence version (issue #178).

  Attribution (`author`), `createdAt`, and `status` are preserved. Comments are
  immutable except for their resolution status.
  """
  type ReviewerComment {
    id: ID!
    """The evidence item the comment refers to."""
    evidenceId: ID!
    """The specific evidence version the comment refers to."""
    evidenceVersion: Int!
    """Author (reviewer) address or account identifier."""
    author: String!
    """Comment body."""
    body: String!
    """Current resolution status."""
    status: ReviewerCommentStatus!
    """Unix timestamp (seconds) when the comment was created."""
    createdAt: Int!
    """Unix timestamp (seconds) when the comment was resolved, if ever."""
    resolvedAt: Int
    """Author who resolved the comment, if ever."""
    resolvedBy: String
  }

  """
  A page of reviewer comments plus shared pagination metadata (issue #178).
  """
  type ReviewerCommentPage {
    items: [ReviewerComment!]!
    pageInfo: PageInfo!
  }

  type CampaignStatusHistory {
    id: ID!
    campaignId: ID!
    fromStatus: CampaignStatus
    toStatus: CampaignStatus!
    changedBy: String!
    changedAt: Int!
    reason: String
  }

  type CampaignVerification {
    emailVerified: Boolean!
    phoneVerified: Boolean!
    addressVerified: Boolean!
    badges: [String!]!
    status: String!
    isVerified: Boolean!
    verifiedCount: Int!
    totalCount: Int!
  }

  type CampaignRiskAssessment {
    score: Int!
    level: String!
    redFlags: [String!]!
    reasons: [String!]!
    flagged: Boolean!
  }

  type CampaignHealthBreakdown {
    descriptionQuality: Int!
    creatorHistory: Int!
    responseTime: Int!
    backerFeedback: Int!
  }

  type CampaignHealthAssessment {
    score: Int!
    level: String!
    breakdown: CampaignHealthBreakdown!
  }

  type Campaign {
    id: ID!
    creator: String!
    name: String!
    description: String
    status: CampaignStatus!
    goalAmount: String!
    raisedAmount: String!
    sponsorCount: Int!
    treeCount: Int!
    createdAt: Int!
    updatedAt: Int!
    statusChangedAt: Int!
    verification: CampaignVerification
    verificationStatus: String!
    verified: Boolean!
    verificationBadges: [String!]!
    riskScore: Int!
    riskLevel: String!
    riskFlags: [String!]!
    riskAssessment: CampaignRiskAssessment
    healthScore: Int!
    healthLevel: String!
    healthAssessment: CampaignHealthAssessment
    sponsors: [CampaignSponsor!]!
    statusHistory: [CampaignStatusHistory!]!
  }

  input TreeFilter {
    planter: String
    region: String
    status: StreamStatus
    search: String
  }

  type Tree {
    id: ID!
    planter: String!
    region: String
    category: String
    status: StreamStatus!
    asset: String!
    sponsoredAmount: String!
    createdAt: Int!
  }

  type Planter {
    address: ID!
    region: String
    treeCount: Int!
    sponsoredAmount: String!
  }

  type Contract {
    address: ID!
    symbol: String!
    streamCount: Int!
    totalVolume: String!
  }

  """
  Lifecycle state of a contract deployment (issue #218).

  Transitions: PENDING -> ACTIVE -> DEPRECATED -> RETIRED. A deployment may
  move to FAILED from any non-RETIRED state; FAILED deployments are retained
  for audit and never silently dropped.
  """
  enum DeploymentStatus {
    PENDING
    ACTIVE
    DEPRECATED
    RETIRED
    FAILED
  }

  """
  A validated contract deployment record (issue #218).

  Every environment (network + ledger) has exactly one record per contract
  address. Records are append-only for audit purposes: lifecycle changes are
  recorded, not overwritten.
  """
  type ContractDeployment {
    """Stable identifier for this deployment record."""
    id: ID!
    """Network the contract is deployed to."""
    network: Network!
    """Contract address (C… Stellar address)."""
    address: String!
    """Ledger sequence the deployment was recorded at."""
    ledger: Int!
    """Contract spec version deployed (e.g. '1.2.0')."""
    specVersion: String!
    """Current lifecycle state."""
    status: DeploymentStatus!
    """Unix timestamp (seconds) the deployment was first recorded."""
    deployedAt: Int!
    """Unix timestamp (seconds) of the last lifecycle transition."""
    updatedAt: Int!
    """Human-readable reason for the last lifecycle transition, if any."""
    statusReason: String
  }

  """
  A canonical contract-event domain mapping (issue #219).

  Supported event versions map to a named projection. Unknown event versions
  are retained with `known: false` and a null `projection` rather than being
  dropped, so operators can inspect and backfill them.
  """
  type ContractEventMapping {
    """Event type name (e.g. 'stream_created')."""
    eventType: String!
    """Event schema version (e.g. 'v1', 'v2')."""
    version: String!
    """Projection the event maps to. Null for unknown versions."""
    projection: String
    """Whether this version has a canonical mapping."""
    known: Boolean!
    """Unix timestamp (seconds) the mapping was registered."""
    registeredAt: Int!
  }

  """
  Status of a projection replay run across event-schema versions (issue #220).

  Replays rebuild state deterministically from retained raw events and compare
  the output against the live projection before cutover. A run in
  `MISMATCH` or `FAILED` state blocks cutover and must be investigated.
  """
  enum ReplayStatus {
    PENDING
    RUNNING
    MATCHED
    MISMATCH
    FAILED
  }

  """
  A projection replay run (issue #220).

  `mismatchCount` is the number of events whose replayed projection differs
  from the live projection. Cutover is only permitted when status is MATCHED.
  """
  type ProjectionReplay {
    """Stable identifier for this replay run."""
    id: ID!
    """Projection being replayed (e.g. 'streams')."""
    projection: String!
    """Source event-schema version replayed from."""
    fromVersion: String!
    """Target event-schema version replayed to."""
    toVersion: String!
    """Current replay status."""
    status: ReplayStatus!
    """Number of events replayed so far."""
    processedCount: Int!
    """Number of events whose replayed output differed."""
    mismatchCount: Int!
    """Unix timestamp (seconds) the replay started."""
    startedAt: Int!
    """Unix timestamp (seconds) the replay finished, if it has."""
    finishedAt: Int
    """Human-readable failure or mismatch detail, if any."""
    error: String
  }

  """
  Bounded-queue and concurrency metrics for an event consumer (issue #222).

  `droppedCount` is always 0: consumers apply backpressure instead of dropping
  events. `degraded` is true when the consumer is applying backpressure or
  recovering from an outage.
  """
  type ConsumerQueueMetrics {
    """Consumer identifier (e.g. 'stream-indexer')."""
    consumer: String!
    """Maximum queue capacity (bounded)."""
    capacity: Int!
    """Current queue depth."""
    depth: Int!
    """Maximum concurrent in-flight events."""
    concurrency: Int!
    """Events currently in flight."""
    inFlight: Int!
    """Events dropped due to overflow. Always 0 (backpressure applied)."""
    droppedCount: Int!
    """Whether the consumer is applying backpressure or recovering."""
    degraded: Boolean!
    """Unix timestamp (seconds) the metrics were sampled."""
    sampledAt: Int!
  }

  enum SequelRelation {
    SEQUEL
    PREQUEL
    SPINOFF
    RELATED
  }

  type CampaignSeries {
    id: ID!
    name: String!
    description: String
    creator: String!
    campaignIds: [ID!]!
    createdAt: Int!
    updatedAt: Int!
  }

  type CampaignSequelLink {
    id: ID!
    sourceCampaignId: ID!
    targetCampaignId: ID!
    relation: SequelRelation!
    order: Int
    seriesId: ID
    notes: String
    linkedBy: String!
    linkedAt: Int!
  }

  """A campaign plus how it relates to the queried campaign."""
  type CampaignSequelSummary {
    link: CampaignSequelLink!
    campaign: Campaign!
  }

  """The campaign that continues a series, with its series context."""
  type NextInSeriesResult {
    link: CampaignSequelLink!
    series: CampaignSeries
    campaign: Campaign!
  }

  """Per-campaign creator analytics dashboard (issue: analytics dashboard)."""
  type TrafficSourceStat {
    source: String!
    label: String!
    visitors: Int!
    views: Int!
    share: Float!
  }

  type FunnelStage {
    stage: String!
    label: String!
    count: Int!
    conversionRate: Float!
    dropoffRate: Float!
  }

  type BackerDemographic {
    region: String!
    backers: Int!
    totalAmount: String!
    share: Float!
  }

  type RewardTierStat {
    tierId: String!
    name: String!
    price: String!
    backers: Int!
    revenue: String!
    share: Float!
  }

  type DailyFundingPoint {
    date: String!
    amount: String!
    contributions: Int!
    cumulative: String!
  }

  type CampaignAnalyticsDashboard {
    campaignId: ID!
    updatedAt: Int!
    trafficSources: [TrafficSourceStat!]!
    funnel: [FunnelStage!]!
    demographics: [BackerDemographic!]!
    rewardTiers: [RewardTierStat!]!
    dailyTrend: [DailyFundingPoint!]!
    totals: CampaignAnalyticsTotals!
  }

  type CampaignAnalyticsTotals {
    visitors: Int!
    contributions: Int!
    totalFunded: String!
    conversionRate: Float!
  }

  enum GrantProgramStatus {
    OPEN
    PAUSED
    CLOSED
  }

  type GrantProgram {
    id: ID!
    name: String!
    description: String
    matchPercentage: Int!
    perCampaignCap: String!
    totalPool: String!
    allocated: String!
    eligibilityCriteria: [String!]!
    status: GrantProgramStatus!
    createdAt: Int!
    updatedAt: Int!
  }

  type GrantAllocation {
    id: ID!
    programId: ID!
    campaignId: ID!
    baseContribution: String!
    matchedAmount: String!
    allocatedBy: String!
    allocatedAt: Int!
  }

  type GrantProgramSummary {
    program: GrantProgram!
    remainingPool: String!
    eligible: Boolean!
    matchedForCampaign: String!
    nextMatchAmount: String!
  }

  """
  A page of campaigns plus shared pagination metadata (issue #59).
  """
  type CampaignPage {
    items: [Campaign!]!
    pageInfo: PageInfo!
  }

  """
  A page of backers plus shared pagination metadata (issue #59).
  """
  type BackerPage {
    items: [CampaignSponsor!]!
    pageInfo: PageInfo!
  }

  """
  A page of audit entries plus shared pagination metadata (issue #59).
  """
  type AuditEntryPage {
    items: [CampaignStatusHistory!]!
    pageInfo: PageInfo!
  }

  """
  A page of analytics rows plus shared pagination metadata (issue #59).
  """
  type AnalyticsPage {
    items: [DailyFundingPoint!]!
    pageInfo: PageInfo!
  }

  type Query {
    """
    Search individual sponsored trees derived from indexed payment streams.

    Paginated with the shared PaginationInput (default limit 20, max 100).
    Default sort: createdAt DESC, tiebroken by id ASC.
    """
    campaigns(filter: CampaignFilter, sort: CampaignSort, pagination: PaginationInput, network: Network): [Campaign!]!

    """
    Paginated campaign list with shared pagination metadata (issue #59).

    Default sort: createdAt DESC, tiebroken by id ASC. Limit defaults to 20
    and is capped at 100.
    """
    campaignPage(filter: CampaignFilter, sort: SortInput, pagination: PaginationInput, network: Network): CampaignPage!

    """
    Paginated backer (sponsor) list for a campaign with shared pagination
    metadata (issue #59).

    Default sort: sponsoredAt DESC, tiebroken by id ASC. Limit defaults to 20
    and is capped at 100.
    """
    campaignBackers(campaignId: ID!, sort: SortInput, pagination: PaginationInput, network: Network): BackerPage!

    """
    Paginated audit trail of campaign status changes with shared pagination
    metadata (issue #59).

    Default sort: changedAt DESC, tiebroken by id ASC. Limit defaults to 20
    and is capped at 100.
    """
    campaignAuditLog(campaignId: ID!, sort: SortInput, pagination: PaginationInput): AuditEntryPage!

    """
    Paginated daily funding trend for a campaign with shared pagination
    metadata (issue #59).

    Default sort: date DESC. Limit defaults to 20 and is capped at 100.
    """
    campaignAnalyticsTrend(campaignId: ID!, sort: SortInput, pagination: PaginationInput, network: Network): AnalyticsPage!

    trees(filter: TreeFilter, pagination: PaginationInput, network: Network): [Tree!]!

    """
    List planters with aggregate sponsorship counts and volume.
    """
    planters(region: String, pagination: PaginationInput, network: Network): [Planter!]!

    """
    List contract/token aggregates used by the payment-stream protocol.
    """
    contracts(pagination: PaginationInput, network: Network): [Contract!]!

    """
    List validated contract deployment records (issue #218).

    Omit `network` to return deployments across all networks. Omit `status` to
    return deployments in every lifecycle state, including FAILED.
    """
    contractDeployments(
      network: Network
      status: DeploymentStatus
      pagination: PaginationInput
    ): [ContractDeployment!]!

    """
    A single contract deployment record by network and address (issue #218).
    Returns null when no record exists.
    """
    contractDeployment(network: Network!, address: String!): ContractDeployment

    """
    Canonical contract-event domain mappings (issue #219).

    Unknown event versions are included with `known: false` and a null
    `projection`; they are retained rather than dropped.
    """
    contractEventMappings(
      eventType: String
      version: String
      pagination: PaginationInput
    ): [ContractEventMapping!]!

    """
    Projection replay runs across event-schema versions (issue #220).

    Omit `status` to return runs in every state, including MISMATCH and FAILED.
    """
    projectionReplays(
      projection: String
      status: ReplayStatus
      pagination: PaginationInput
    ): [ProjectionReplay!]!

    """
    Bounded-queue and concurrency metrics for event consumers (issue #222).

    Omit `consumer` to return metrics for all consumers.
    """
    consumerQueueMetrics(consumer: String): [ConsumerQueueMetrics!]!

    """
    Global aggregate metrics across all streams on the specified network.
    """
    globalMetrics(network: Network): GlobalMetrics!

    """
    Aggregate metrics broken down by geographic region.
    Regions are derived from stream metadata tags.
    """
    regionMetrics(
      filter: RegionFilter
      pagination: PaginationInput
      network: Network
    ): [RegionMetrics!]!

    """
    Aggregate metrics broken down by funding category.
    Categories are derived from stream metadata tags.
    """
    categoryMetrics(
      filter: CategoryFilter
      pagination: PaginationInput
      network: Network
    ): [CategoryMetrics!]!

    """
    Aggregate metrics broken down by asset (token contract address).
    """
    assetMetrics(
      filter: AssetFilter
      pagination: PaginationInput
      network: Network
    ): [AssetMetrics!]!

    """
    Fetch job board postings with sort options.
    """
    jobBoard(
      """Sort order for the job list."""
      sort: JobSort = PAY_HIGHEST
      """Pagination options."""
      pagination: PaginationInput
    ): [Job!]!

    """
    A sponsor's impact (estimated CO2 offset) compared with the global
    average sponsor, including a percentile ranking (top 10%, etc.).
    """
    sponsorImpact(address: String!, network: Network): SponsorImpact!

    """
    Campaigns linked to the given campaign as sequels, prequels, spin-offs,
    or related projects, including the franchise (series) it belongs to.
    """
    campaignSequels(campaignId: ID!, relation: SequelRelation): [CampaignSequelSummary!]!

    """
    The next campaign in a series (franchise) for the given campaign, when one
    exists.
    """
    nextInSeries(campaignId: ID!): NextInSeriesResult

    """
    Detailed creator analytics for a campaign: traffic sources, conversion
    funnel, backer demographics, reward tier popularity, and daily funding
    trends.
    """
    campaignAnalytics(campaignId: ID!, network: Network): CampaignAnalyticsDashboard

    """
    The platform-funded grant matching programs available to underrepresented
    creators.
    """
    grantPrograms: [GrantProgram!]!

    """
    Matching summary for a campaign within a grant program: eligibility,
    amount already matched, and the next match available.
    """
    grantProgramSummary(programId: ID!, campaignId: ID!): GrantProgramSummary

    """
    The grant allocations awarded to a campaign across all programs.
    """
    campaignGrantAllocations(campaignId: ID!): [GrantAllocation!]!

    """
    The current donor-facing terms snapshot for a campaign (issue #176).

    Clients must display this snapshot and verify its `contentHash` before
    signing a contribution. The snapshot returned here is the one that will be
    bound to the next contribution.
    """
    campaignTermsSnapshot(campaignId: ID!): TermsSnapshot!

    """
    A contribution with its bound terms snapshot (issue #176).
    """
    campaignDonation(donationId: ID!): CampaignDonation

    """
    The receipt for a contribution, including its bound terms snapshot
    (issue #176).
    """
    donationReceipt(donationId: ID!): DonationReceipt

    """
    Reviewer comments for a specific evidence version (issue #178).

    Default sort: createdAt DESC, tiebroken by id ASC. Limit defaults to 20 and
    is capped at 100.

    Auth policy: privileged (requires an authenticated reviewer account).
    """
    reviewerComments(
      evidenceId: ID!
      evidenceVersion: Int!
      status: ReviewerCommentStatus
      sort: SortInput
      pagination: PaginationInput
    ): ReviewerCommentPage!
  }

  """
  A clone of an existing indexed stream/campaign returned by cloneCampaign.
  """
  type CloneResult {
    id: ID!
    sender: String!
    recipient: String!
    token: String!
    status: StreamStatus!
    totalAmount: String!
    withdrawnAmount: String!
    startTime: Int!
    endTime: Int!
  }

  """
  A webhook subscription owned by the authenticated account.

  Auth policy: privileged (requires an authenticated account; only the owning
  account may read or mutate its subscriptions — see issue #69).

  The signing secret is NEVER exposed on this type. It is returned exactly once
  by the createWebhookSubscription and rotateWebhookSecret mutations.
  """
  type WebhookSubscription {
    """Unique subscription identifier."""
    id: ID!
    """Owning account identifier (never another account's id)."""
    ownerId: ID!
    """HTTPS endpoint that receives webhook deliveries."""
    url: String!
    """Event types this subscription is subscribed to."""
    events: [String!]!
    """Whether the subscription is currently active."""
    active: Boolean!
    """Unix timestamp (seconds) when the subscription was created."""
    createdAt: Int!
    """Unix timestamp (seconds) of the last secret rotation, if any."""
    secretRotatedAt: Int
    """Unix timestamp (seconds) when the subscription was revoked, if any."""
    revokedAt: Int
  }

  """
  Result of creating a webhook subscription. The plaintext signing secret is
  revealed only here, exactly once, and is never retrievable afterwards.
  """
  type WebhookSubscriptionCreated {
    """The public subscription record (contains no secret)."""
    subscription: WebhookSubscription!
    """
    The plaintext signing secret. Shown only on creation; store it securely.
    """
    secret: String!
  }

  """
  Result of rotating a webhook subscription's signing secret. The new secret
  is revealed only here, exactly once.
  """
  type WebhookSecretRotation {
    """The public subscription record (contains no secret)."""
    subscription: WebhookSubscription!
    """The new plaintext signing secret. Shown only on rotation."""
    secret: String!
  }

  type Mutation {
    """
    Clones an indexed stream so a creator can start from an existing campaign.

    Auth policy: authenticated (requires a valid account session).
    """
    cloneCampaign(id: ID!, network: Network): CloneResult

    """
    Creates a webhook subscription for the authenticated account and returns
    the signing secret exactly once.

    Auth policy: privileged (authenticated account; subscription is always
    scoped to the caller's account — cross-account creation is rejected).
    """
    createWebhookSubscription(
      url: String!
      events: [String!]!
    ): WebhookSubscriptionCreated!

    """
    Rotates the signing secret for a subscription owned by the authenticated
    account, returning the new secret exactly once. Previous secret is
    invalidated immediately.

    Auth policy: privileged (owner only; non-owners receive NOT_FOUND).
    """
    rotateWebhookSecret(id: ID!): WebhookSecretRotation!

    """
    Revokes a webhook subscription owned by the authenticated account. Revoked
    subscriptions stop receiving deliveries and cannot be rotated.

    Auth policy: privileged (owner only; non-owners receive NOT_FOUND).
    """
    revokeWebhookSubscription(id: ID!): WebhookSubscription!

    """
    Creates a reviewer comment on a specific evidence version (issue #178).

    The author is always the authenticated reviewer; attribution is taken from
    the session and cannot be spoofed by the client.

    Auth policy: privileged (authenticated reviewer; unauthenticated callers
    receive UNAUTHENTICATED).
    """
    createReviewerComment(
      evidenceId: ID!
      evidenceVersion: Int!
      body: String!
    ): ReviewerComment!

    """
    Resolves a reviewer comment (issue #178). Idempotent: resolving an already
    resolved comment returns it unchanged.

    Auth policy: privileged (authenticated reviewer; non-reviewers receive
    FORBIDDEN).
    """
    resolveReviewerComment(id: ID!): ReviewerComment!
  }

  extend type Query {
    """
    Lists the webhook subscriptions owned by the authenticated account. Public
    records only — secrets are never included.

    Auth policy: privileged (returns only the caller's own subscriptions).
    """
    webhookSubscriptions: [WebhookSubscription!]!
  }
`;

/**
 * Build the validation rule set that enforces the depth and complexity
 * budgets for a request. Exported so the GraphQL server setup can pass the
 * result as `validationRules` to the execution engine.
 *
 * @param limits Optional budget overrides (defaults to DEFAULT_QUERY_LIMITS).
 */
export function createQueryValidationRules(limits: Partial<QueryLimits> = {}) {
  const resolved: QueryLimits = { ...DEFAULT_QUERY_LIMITS, ...limits };
  return [createDepthLimitRule(resolved), createComplexityLimitRule(resolved)];
}

/**
 * Wrap a GraphQL schema so every resolver execution is bounded by the
 * configured timeout. Abusive or runaway queries are rejected with a clear
 * error instead of holding server resources indefinitely.
 *
 * @param schema The schema to guard.
 * @param limits Optional budget overrides (defaults to DEFAULT_QUERY_LIMITS).
 */
export function applyQueryLimits(
  schema: GraphQLSchema,
  limits: Partial<QueryLimits> = {},
): GraphQLSchema {
  const resolved: QueryLimits = { ...DEFAULT_QUERY_LIMITS, ...limits };
  return withExecutionTimeout(schema, resolved);
}

export {
  DEFAULT_QUERY_LIMITS,
  createDepthLimitRule,
  createComplexityLimitRule,
  withExecutionTimeout,
};
export type { QueryLimits };