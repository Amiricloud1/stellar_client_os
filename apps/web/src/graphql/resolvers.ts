/*
 * GraphQL Resolvers — Aggregate Funding Analytics (issue #538)
 *
 * Thin resolver layer that delegates to the AnalyticsService.
 * Each resolver maps 1:1 to a Query field in the schema.
 */

import { DefaultStreamDataSource, getAnalyticsService } from "./analytics.service";
import { withExecutionTimeout } from "./query-guard";
import { getDeploymentRegistryService } from "@/services/deployment-registry.service";
import { getContractEventMappingService } from "@/services/contract-event-mapping.service";
import { getProjectionReplayService } from "@/services/projection-replay.service";
import { getEventConsumerMetricsService } from "@/services/event-consumer-metrics.service";
import { getCampaignHealthAssessment, getCampaignRiskAssessment, getCampaignVerificationSummary, queryCampaigns } from "@/services/campaign.service";
import type { CampaignDataSource, CampaignQueryInput } from "@/services/campaign.service";
import { getCampaignSequelService } from "@/services/campaign-sequel.service";
import { getCampaignAnalyticsDashboard } from "@/services/campaign-analytics-dashboard.service";
import { getGrantProgramService } from "@/services/grant-program.service";
import {
  buildPageInfo,
  normalizePagination,
  paginateItems,
  resolveSort,
  validatePagination,
} from "@/services/pagination.service";
import type { PageInfo, PaginationInput as SharedPaginationInput, SortInput } from "@/services/pagination.service";
import type {
  RegionFilter,
  CategoryFilter,
  AssetFilter,
  PaginationInput,
  StreamDataSource,
  StreamStatusFilter,
} from "./analytics.service";

type Network = "testnet" | "mainnet";

interface ResolverContext {
  /** Optional custom data source — used in tests to inject fixtures. */
  dataSource?: StreamDataSource;
  campaignDataSource?: CampaignDataSource;
  /** Authenticated account id, populated by the API auth middleware. */
  accountId?: string;
  /** Roles granted to the authenticated account. */
  roles?: string[];
}

function resolveDataSource(ctx: ResolverContext, fallback?: StreamDataSource): StreamDataSource {
  return ctx.dataSource ?? fallback ?? new DefaultStreamDataSource();
}

/**
 * Run an analytics resolver under the configured execution-time budget.
 *
 * Expensive aggregate queries (global/region/category/asset metrics and
 * sponsor impact) are wrapped so that a slow data source cannot hold a
 * request open indefinitely. The timeout is configurable via
 * `GRAPHQL_EXECUTION_TIMEOUT_MS` (see `query-guard.ts`).
 */
function runAnalytics<T>(operation: () => Promise<T> | T): Promise<T> {
  return withExecutionTimeout(operation);
}

function toBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Require an authenticated account for operator-only fields.
 *
 * Deployment registry mutations, projection replays and consumer metrics are
 * operational surfaces: they expose deployment state and can trigger
 * state-rebuilding work, so they are restricted to authenticated operators.
 * Unauthenticated callers receive an explicit authorization error rather than
 * an empty result (issues #218, #220, #222).
 */
function requireOperator(ctx: ResolverContext): string {
  const accountId = ctx.accountId;
  if (!accountId) {
    throw new Error("Unauthorized: an authenticated operator account is required");
  }
  const roles = ctx.roles ?? [];
  if (roles.length > 0 && !roles.includes("operator") && !roles.includes("admin")) {
    throw new Error("Forbidden: operator role required");
  }
  return accountId;
}

/**
 * Shared pagination contract (issue #59).
 *
 * Every list resolver accepts the same `pagination` input, validates it via
 * `validatePagination`, clamps it to the shared page limits, and returns a
 * `PageInfo` object alongside the items so clients can page deterministically.
 */
interface PaginatedResult<T> {
  items: T[];
  pageInfo: PageInfo;
}

function toSharedPagination(pagination?: PaginationInput): SharedPaginationInput | undefined {
  if (!pagination) return undefined;
  return { limit: pagination.limit, offset: pagination.offset };
}

function paginate<T>(
  items: T[],
  pagination?: PaginationInput,
  sort?: SortInput,
): PaginatedResult<T> {
  const normalized = normalizePagination(toSharedPagination(pagination));
  const sorted = resolveSort(items, sort);
  const page = paginateItems(sorted, normalized);
  return {
    items: page.items,
    pageInfo: buildPageInfo(sorted.length, normalized),
  };
}

function validateListArgs(pagination?: PaginationInput, sort?: SortInput): void {
  validatePagination(toSharedPagination(pagination));
  if (sort && (!sort.field || typeof sort.field !== "string")) {
    throw new Error("sort.field must be a non-empty string");
  }
  if (sort?.direction && sort.direction !== "ASC" && sort.direction !== "DESC") {
    throw new Error("sort.direction must be ASC or DESC");
  }
}

function toCampaignPayload(campaign: import("@/services/campaign.service").CampaignRecord) {
  const verification = getCampaignVerificationSummary(campaign);
  const riskAssessment = getCampaignRiskAssessment(campaign);
  const healthAssessment = getCampaignHealthAssessment(campaign);

  return {
    ...campaign,
    verification,
    verificationStatus: verification.status,
    verified: verification.isVerified,
    verificationBadges: verification.badges,
    riskAssessment,
    riskScore: riskAssessment.score,
    riskLevel: riskAssessment.level,
    riskFlags: riskAssessment.redFlags,
    healthAssessment,
    healthScore: healthAssessment.score,
    healthLevel: healthAssessment.level,
    createdAt: Math.floor(campaign.createdAt / 1000),
    updatedAt: Math.floor(campaign.updatedAt / 1000),
    statusChangedAt: Math.floor(campaign.statusChangedAt / 1000),
    sponsors: campaign.sponsors.map((sponsor) => ({ ...sponsor, sponsoredAt: Math.floor(sponsor.sponsoredAt / 1000) })),
    statusHistory: campaign.statusHistory.map((entry) => ({ ...entry, changedAt: Math.floor(entry.changedAt / 1000) })),
  };
}

function toProgramPayload(program: import("@/services/grant-program.service").GrantProgram) {
  return {
    ...program,
    createdAt: Math.floor(program.createdAt / 1000),
    updatedAt: Math.floor(program.updatedAt / 1000),
  };
}

export function createResolvers(defaultDataSource?: StreamDataSource) {
  return {
    Query: {
      campaigns: async (
        _: unknown,
        rawArgs: {
          filter?: CampaignQueryInput["filter"];
          sort?: CampaignQueryInput["sort"];
          pagination?: PaginationInput;
          network?: Network;
        },
        ctx: ResolverContext,
      ) => {
        validateListArgs(args.pagination);
        const normalized = normalizePagination(toSharedPagination(args.pagination));
        const campaigns = await queryCampaigns({
          filter: args.filter,
          sort: args.sort,
          limit: normalized.limit,
          offset: normalized.offset,
          network: args.network,
        }, ctx.campaignDataSource);
        return {
          items: campaigns.map(toCampaignPayload),
          pageInfo: buildPageInfo(campaigns.length, normalized),
        };
      },

      trees: async (
        _: unknown,
        rawArgs: {
          filter?: { planter?: string; region?: string; status?: StreamStatusFilter; search?: string };
          pagination?: PaginationInput;
          sort?: SortInput;
          network?: Network;
        },
        ctx: ResolverContext,
      ) => {
        validateListArgs(args.pagination, args.sort);
        const streams = await resolveDataSource(ctx, defaultDataSource).getStreams(args.network ?? "testnet");
        const filter = args.filter ?? {};
        const filtered = streams.filter((stream) => {
          if (filter.planter && stream.recipient !== filter.planter) return false;
          if (filter.region && stream.region !== filter.region) return false;
          if (filter.status && stream.status !== filter.status) return false;
          if (filter.search) {
            const haystack = `${stream.id} ${stream.recipient} ${stream.region ?? ""} ${stream.category ?? ""}`.toLowerCase();
            if (!haystack.includes(filter.search.toLowerCase())) return false;
          }
          return true;
        });
        return paginate(filtered.map((stream) => ({
          id: stream.id,
          planter: stream.recipient,
          region: stream.region ?? null,
          category: stream.category ?? null,
          status: stream.status,
          asset: stream.asset,
          sponsoredAmount: stream.totalAmount,
          createdAt: stream.createdAt,
        })), args.pagination, args.sort);
      },

      planters: async (
        _: unknown,
        args: { region?: string; pagination?: PaginationInput; sort?: SortInput; network?: Network },
        ctx: ResolverContext,
      ) => {
        validateListArgs(args.pagination, args.sort);
        const streams = await resolveDataSource(ctx, defaultDataSource).getStreams(args.network ?? "testnet");
        const groups = new Map<string, { region: string | null; treeCount: number; sponsoredAmount: bigint }>();
        for (const stream of streams) {
          if (args.region && stream.region !== args.region) continue;
          const current = groups.get(stream.recipient) ?? { region: stream.region ?? null, treeCount: 0, sponsoredAmount: 0n };
          current.treeCount += 1;
          current.sponsoredAmount += toBigInt(stream.totalAmount);
          groups.set(stream.recipient, current);
        }
        return paginate(Array.from(groups, ([address, value]) => ({
          address,
          region: value.region,
          treeCount: value.treeCount,
          sponsoredAmount: value.sponsoredAmount.toString(),
        })), args.pagination, args.sort);
      },

      contracts: async (
        _: unknown,
        args: { pagination?: PaginationInput; sort?: SortInput; network?: Network },
        ctx: ResolverContext,
      ) => {
        validateListArgs(args.pagination, args.sort);
        const streams = await resolveDataSource(ctx, defaultDataSource).getStreams(args.network ?? "testnet");
        const groups = new Map<string, { symbol: string; streamCount: number; totalVolume: bigint }>();
        for (const stream of streams) {
          const current = groups.get(stream.asset) ?? { symbol: stream.symbol ?? stream.asset.slice(0, 8), streamCount: 0, totalVolume: 0n };
          current.streamCount += 1;
          current.totalVolume += toBigInt(stream.totalAmount);
          groups.set(stream.asset, current);
        }
        return paginate(Array.from(groups, ([address, value]) => ({
          address,
          symbol: value.symbol,
          streamCount: value.streamCount,
          totalVolume: value.totalVolume.toString(),
        })), args.pagination, args.sort);
      },

      /**
       * Global aggregate metrics across all streams.
       *
       * @example
       * query { globalMetrics(network: testnet) { totalStreams activeStreams totalVolumeUsd } }
       */
      globalMetrics: async (
        _: unknown,
        rawArgs: { network?: Network },
        ctx: ResolverContext
      ) => {
        const args = guard<typeof rawArgs>("Query.globalMetrics", ctx, rawArgs, "network");
        const service = getAnalyticsService(ctx.dataSource ?? defaultDataSource);
        return runAnalytics(() => service.getGlobalMetrics(args.network ?? "testnet"));
      },

      /**
       * Aggregate metrics broken down by geographic region.
       *
       * @example
       * query {
       *   regionMetrics(filter: { region: "NG" }, pagination: { limit: 5 }) {
       *     region totalStreams totalVolumeUsd projectCount
       *     assetBreakdown { asset symbol totalVolume streamCount }
       *   }
       * }
       */
      regionMetrics: async (
        _: unknown,
        rawArgs: {
          filter?: RegionFilter;
          pagination?: PaginationInput;
          sort?: SortInput;
          network?: Network;
        },
        ctx: ResolverContext
      ) => {
        validateListArgs(args.pagination, args.sort);
        const service = getAnalyticsService(ctx.dataSource ?? defaultDataSource);
        return runAnalytics(() =>
          service.getRegionMetrics(
            args.filter,
            args.pagination,
            args.network ?? "testnet"
          )
        );
        return paginate(rows, args.pagination, args.sort);
      },

      /**
       * Aggregate metrics broken down by funding category.
       *
       * @example
       * query {
       *   categoryMetrics(filter: { category: "climate" }) {
       *     category totalStreams totalVolumeUsd sharePercent
       *   }
       * }
       */
      categoryMetrics: async (
        _: unknown,
        rawArgs: {
          filter?: CategoryFilter;
          pagination?: PaginationInput;
          sort?: SortInput;
          network?: Network;
        },
        ctx: ResolverContext
      ) => {
        validateListArgs(args.pagination, args.sort);
        const service = getAnalyticsService(ctx.dataSource ?? defaultDataSource);
        return runAnalytics(() =>
          service.getCategoryMetrics(
            args.filter,
            args.pagination,
            args.network ?? "testnet"
          )
        );
        return paginate(rows, args.pagination, args.sort);
      },

      /**
       * Aggregate metrics broken down by asset (token contract address).
       *
       * @example
       * query {
       *   assetMetrics(filter: { status: Active }) {
       *     asset symbol totalVolume streamCount uniqueSenders uniqueRecipients
       *   }
       * }
       */
      assetMetrics: async (
        _: unknown,
        rawArgs: {
          filter?: AssetFilter;
          pagination?: PaginationInput;
          sort?: SortInput;
          network?: Network;
        },
        ctx: ResolverContext
      ) => {
        validateListArgs(args.pagination, args.sort);
        const service = getAnalyticsService(ctx.dataSource ?? defaultDataSource);
        return runAnalytics(() =>
          service.getAssetMetrics(
            args.filter,
            args.pagination,
            args.network ?? "testnet"
          )
        );
        return paginate(rows, args.pagination, args.sort);
      },

      /**
       * A sponsor's impact (estimated CO2 offset) vs the global average
       * sponsor, including a percentile ranking (top 10%, etc.).
       *
       * @example
       * query {
       *   sponsorImpact(address: "GAAA") {
       *     myVolumeUsd myCo2OffsetKg globalAverageCo2OffsetKg
       *     globalSponsorCount percentile rankingBand
       *   }
       * }
       */
      sponsorImpact: async (
        _: unknown,
        rawArgs: { address: string; network?: Network },
        ctx: ResolverContext
      ) => {
        const args = guard<typeof rawArgs>("Query.sponsorImpact", ctx, rawArgs, "sponsorImpact");
        const service = getAnalyticsService(ctx.dataSource ?? defaultDataSource);
        return runAnalytics(() =>
          service.getSponsorImpact(args.address, args.network ?? "testnet")
        );
      },

      campaignSequels: async (
        _: unknown,
        rawArgs: { campaignId: string; relation?: "SEQUEL" | "PREQUEL" | "SPINOFF" | "RELATED" },
        ctx: ResolverContext,
      ) => {
        const args = guard<typeof rawArgs>("Query.campaignSequels", ctx, rawArgs, "campaignSequels");
        const sequels = await getCampaignSequelService(ctx.campaignDataSource).getSequels(args.campaignId, {
          relation: args.relation,
        });
        return sequels.map(({ link, campaign }) => ({
          link: {
            ...link,
            linkedAt: Math.floor(link.linkedAt / 1000),
          },
          campaign: toCampaignPayload(campaign),
        }));
      },

      nextInSeries: async (
        _: unknown,
        rawArgs: { campaignId: string },
        ctx: ResolverContext,
      ) => {
        const args = guard<typeof rawArgs>("Query.nextInSeries", ctx, rawArgs, "campaignId");
        const result = await getCampaignSequelService(ctx.campaignDataSource).getNextInSeries(args.campaignId);
        if (!result) return null;
        return {
          link: { ...result.link, linkedAt: Math.floor(result.link.linkedAt / 1000) },
          series: result.series
            ? { ...result.series, createdAt: Math.floor(result.series.createdAt / 1000), updatedAt: Math.floor(result.series.updatedAt / 1000) }
            : null,
          campaign: toCampaignPayload(result.campaign),
        };
      },

      campaignAnalytics: async (
        _: unknown,
        rawArgs: { campaignId: string; network?: Network },
        ctx: ResolverContext,
      ) => {
        return runAnalytics(() => getCampaignAnalyticsDashboard(args.campaignId));
      },

      grantPrograms: async (
        _: unknown,
        args: { pagination?: PaginationInput; sort?: SortInput } = {},
      ) => {
        validateListArgs(args.pagination, args.sort);
        const programs = await getGrantProgramService().listPrograms();
        return paginate(programs.map(toProgramPayload), args.pagination, args.sort);
      },

      grantProgramSummary: async (
        _: unknown,
        rawArgs: { programId: string; campaignId: string },
        ctx: ResolverContext,
      ) => {
        const args = guard<typeof rawArgs>("Query.grantProgramSummary", ctx, rawArgs, "grantProgramSummary");
        const summary = await getGrantProgramService().getProgramSummary(args.programId, args.campaignId);
        if (!summary) return null;
        return {
          ...summary,
          program: toProgramPayload(summary.program),
        };
      },

      campaignGrantAllocations: async (
        _: unknown,
        args: { campaignId: string; pagination?: PaginationInput; sort?: SortInput },
      ) => {
        validateListArgs(args.pagination, args.sort);
        const allocations = await getGrantProgramService().getCampaignAllocations(args.campaignId);
        return paginate(allocations.map((allocation) => ({
          ...allocation,
          allocatedAt: Math.floor(allocation.allocatedAt / 1000),
        })), args.pagination, args.sort);
      },

      /**
       * List webhook subscriptions owned by the authenticated account.
       * Secrets are never returned after creation (issue #69).
       */
      webhookSubscriptions: async (
        _: unknown,
        rawArgs: { pagination?: PaginationInput },
        ctx: ResolverContext,
      ) => {
        const args = guard<typeof rawArgs>("Query.webhookSubscriptions", ctx, rawArgs, "pagination");
        const accountId = requireAccountId(ctx);
        const subscriptions = await getWebhookSubscriptionService().listSubscriptions(accountId);
        return paginate(subscriptions.map(toWebhookPayload), args.pagination);
      },

      /**
       * Validated contract deployment registry (issue #218).
       *
       * Returns every recorded deployment with its network, address,
       * deployment ledger, spec version and lifecycle state. Operators can
       * filter by network or lifecycle state.
       */
      contractDeployments: async (
        _: unknown,
        rawArgs: {
          filter?: { network?: Network; state?: string; specVersion?: string };
          pagination?: PaginationInput;
          sort?: SortInput;
        },
        ctx: ResolverContext,
      ) => {
        requireOperator(ctx);
        validateListArgs(rawArgs.pagination, rawArgs.sort);
        const deployments = await getDeploymentRegistryService().listDeployments(rawArgs.filter);
        return paginate(deployments.map(toDeploymentPayload), rawArgs.pagination, rawArgs.sort);
      },

      /**
       * A single deployment record by network + address (issue #218).
       * Returns null when the pair is not registered.
       */
      contractDeployment: async (
        _: unknown,
        rawArgs: { network: Network; address: string },
        ctx: ResolverContext,
      ) => {
        requireOperator(ctx);
        const args = guard<typeof rawArgs>("Query.contractDeployment", ctx, rawArgs, "contractDeployment");
        const deployment = await getDeploymentRegistryService().getDeployment(args.network, args.address);
        return deployment ? toDeploymentPayload(deployment) : null;
      },

      /**
       * Canonical contract-event domain mappings (issue #219).
       *
       * Supported event versions are mapped to their projection; unknown
       * versions are reported as `UNKNOWN` with the raw payload retained so
       * operators can inspect and backfill them.
       */
      contractEventMappings: async (
        _: unknown,
        rawArgs: {
          filter?: { contract?: string; eventName?: string; version?: string };
          pagination?: PaginationInput;
          sort?: SortInput;
        },
        ctx: ResolverContext,
      ) => {
        requireOperator(ctx);
        validateListArgs(rawArgs.pagination, rawArgs.sort);
        const mappings = await getContractEventMappingService().listMappings(rawArgs.filter);
        return paginate(mappings.map(toEventMappingPayload), rawArgs.pagination, rawArgs.sort);
      },

      /**
       * Projection replay status across event-schema versions (issue #220).
       * Returns the latest replay run, or null when none has been started.
       */
      projectionReplayStatus: async (
        _: unknown,
        rawArgs: { replayId: string },
        ctx: ResolverContext,
      ) => {
        requireOperator(ctx);
        const args = guard<typeof rawArgs>("Query.projectionReplayStatus", ctx, rawArgs, "replayId");
        const status = await getProjectionReplayService().getReplayStatus(args.replayId);
        return status ? toReplayStatusPayload(status) : null;
      },

      /**
       * Bounded event-consumer queue and concurrency metrics (issue #222).
       * Exposes queue depth, capacity, in-flight work and backpressure state.
       */
      eventConsumerMetrics: async (
        _: unknown,
        rawArgs: { consumer?: string },
        ctx: ResolverContext,
      ) => {
        requireOperator(ctx);
        return getEventConsumerMetricsService().getMetrics(rawArgs.consumer);
      },
    },
    Mutation: {
      cloneCampaign: async (
        _: unknown,
        rawArgs: { id: string; network?: Network },
        ctx: ResolverContext
      ) => {
        const args = guard<typeof rawArgs>("Mutation.cloneCampaign", ctx, rawArgs, "cloneCampaign");
        const streams = await resolveDataSource(ctx, defaultDataSource).getStreams(args.network ?? "testnet");
        const campaign = streams.find((stream) => stream.id === args.id);
        if (!campaign) throw new Error(`Campaign ${args.id} not found`);
        return {
          ...campaign,
          id: `cloned-${campaign.id}`,
        };
      },

      /**
       * Update campaign details before launch (issue #721).
       * Allows updating name, description, goalAmount, and deadline before campaign goes live.
       */
      updateCampaign: async (
        _: unknown,
        rawArgs: {
          id: string;
          input: { name?: string; description?: string; goalAmount?: string; deadline?: number };
          network?: Network;
        },
        ctx: ResolverContext
      ) => {
        const args = guard<typeof rawArgs>("Mutation.updateCampaign", ctx, rawArgs, "updateCampaign");
        const streams = await resolveDataSource(ctx, defaultDataSource).getStreams(args.network ?? "testnet");
        const campaign = streams.find((stream) => stream.id === args.id);
        if (!campaign) throw new Error(`Campaign ${args.id} not found`);
        if (campaign.status !== "Draft" && campaign.status !== "Active") {
          throw new Error("Campaign details cannot be modified after launch");
        }
        return {
          ...campaign,
          name: args.input.name ?? campaign.name,
          description: args.input.description ?? campaign.description,
          totalAmount: args.input.goalAmount ?? campaign.totalAmount,
          endTime: args.input.deadline ?? campaign.endTime,
        };
      },

      /**
       * Create a webhook subscription for the authenticated account.
       * The signing secret is returned exactly once, on creation (issue #69).
       */
      createWebhookSubscription: async (
        _: unknown,
        rawArgs: { input: { url: string; events: string[]; description?: string } },
        ctx: ResolverContext,
      ) => {
        const args = guard<typeof rawArgs>("Mutation.createWebhookSubscription", ctx, rawArgs, "createWebhookSubscription");
        const accountId = requireAccountId(ctx);
        const { subscription, secret } = await getWebhookSubscriptionService().createSubscription(accountId, args.input);
        return { ...toWebhookPayload(subscription), secret };
      },

      /**
       * Rotate the signing secret for a subscription owned by the authenticated
       * account. The new secret is returned exactly once (issue #69).
       */
      rotateWebhookSecret: async (
        _: unknown,
        rawArgs: { id: string },
        ctx: ResolverContext,
      ) => {
        const args = guard<typeof rawArgs>("Mutation.rotateWebhookSecret", ctx, rawArgs, "webhookId");
        const accountId = requireAccountId(ctx);
        const { subscription, secret } = await getWebhookSubscriptionService().rotateSecret(accountId, args.id);
        return { ...toWebhookPayload(subscription), secret };
      },

      /**
       * Revoke a subscription owned by the authenticated account. Cross-account
       * access is rejected by the service (issue #69).
       */
      revokeWebhookSubscription: async (
        _: unknown,
        rawArgs: { id: string },
        ctx: ResolverContext,
      ) => {
        const args = guard<typeof rawArgs>("Mutation.revokeWebhookSubscription", ctx, rawArgs, "webhookId");
        const accountId = requireAccountId(ctx);
        const subscription = await getWebhookSubscriptionService().revokeSubscription(accountId, args.id);
        return toWebhookPayload(subscription);
      },

      /**
       * Register or update a contract deployment (issue #218).
       *
       * The registry validates the network/address pair and the deployment
       * ledger before persisting. Duplicate registrations for the same
       * network + address are rejected by the service.
       */
      registerContractDeployment: async (
        _: unknown,
        rawArgs: {
          input: {
            network: Network;
            address: string;
            deploymentLedger: number;
            specVersion: string;
            state?: string;
          };
        },
        ctx: ResolverContext,
      ) => {
        requireOperator(ctx);
        const args = guard<typeof rawArgs>("Mutation.registerContractDeployment", ctx, rawArgs, "registerContractDeployment");
        const deployment = await getDeploymentRegistryService().registerDeployment(args.input);
        return toDeploymentPayload(deployment);
      },

      /**
       * Transition a deployment's lifecycle state (issue #218).
       * Invalid transitions surface as explicit errors from the service.
       */
      updateContractDeploymentState: async (
        _: unknown,
        rawArgs: { network: Network; address: string; state: string },
        ctx: ResolverContext,
      ) => {
        requireOperator(ctx);
        const args = guard<typeof rawArgs>("Mutation.updateContractDeploymentState", ctx, rawArgs, "updateContractDeploymentState");
        const deployment = await getDeploymentRegistryService().updateDeploymentState(
          args.network,
          args.address,
          args.state,
        );
        return toDeploymentPayload(deployment);
      },

      /**
       * Start a deterministic projection replay across event-schema versions
       * (issue #220). The service rebuilds state from retained raw events and
       * compares outputs before cutover; the returned status can be polled via
       * `projectionReplayStatus`.
       */
      startProjectionReplay: async (
        _: unknown,
        rawArgs: { input: { fromVersion: string; toVersion: string; dryRun?: boolean } },
        ctx: ResolverContext,
      ) => {
        requireOperator(ctx);
        const args = guard<typeof rawArgs>("Mutation.startProjectionReplay", ctx, rawArgs, "startProjectionReplay");
        const status = await getProjectionReplayService().startReplay(args.input);
        return toReplayStatusPayload(status);
      },
    },
  };
}

/**
 * Map a deployment record to its public GraphQL shape (issue #218).
 */
function toDeploymentPayload(deployment: import("@/services/deployment-registry.service").ContractDeployment) {
  return {
    network: deployment.network,
    address: deployment.address,
    deploymentLedger: deployment.deploymentLedger,
    specVersion: deployment.specVersion,
    state: deployment.state,
    registeredAt: Math.floor(deployment.registeredAt / 1000),
    updatedAt: Math.floor(deployment.updatedAt / 1000),
  };
}

/**
 * Map a canonical event mapping to its public GraphQL shape (issue #219).
 * Unknown versions retain the raw payload for operator inspection.
 */
function toEventMappingPayload(mapping: import("@/services/contract-event-mapping.service").ContractEventMapping) {
  return {
    contract: mapping.contract,
    eventName: mapping.eventName,
    version: mapping.version,
    projection: mapping.projection,
    status: mapping.status,
    rawPayload: mapping.rawPayload ?? null,
  };
}

/**
 * Map a projection replay status to its public GraphQL shape (issue #220).
 */
function toReplayStatusPayload(status: import("@/services/projection-replay.service").ProjectionReplayStatus) {
  return {
    replayId: status.replayId,
    fromVersion: status.fromVersion,
    toVersion: status.toVersion,
    state: status.state,
    dryRun: status.dryRun,
    processedEvents: status.processedEvents,
    mismatches: status.mismatches,
    startedAt: Math.floor(status.startedAt / 1000),
    completedAt: status.completedAt ? Math.floor(status.completedAt / 1000) : null,
    error: status.error ?? null,
  };
}

/**
 * Map a stored subscription to its public GraphQL shape. The signing secret is
 * intentionally omitted — it is only ever returned from create/rotate.
 */
function toWebhookPayload(subscription: import("@/services/webhook-subscription.service").WebhookSubscription) {
  return {
    id: subscription.id,
    url: subscription.url,
    events: subscription.events,
    description: subscription.description ?? null,
    status: subscription.status,
    createdAt: Math.floor(subscription.createdAt / 1000),
    updatedAt: Math.floor(subscription.updatedAt / 1000),
    lastDeliveredAt: subscription.lastDeliveredAt ? Math.floor(subscription.lastDeliveredAt / 1000) : null,
  };
}