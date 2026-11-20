/*
 * GraphQL Resolvers — Aggregate Funding Analytics (issue #538)
 *
 * Thin resolver layer that delegates to the AnalyticsService.
 * Each resolver maps 1:1 to a Query field in the schema.
 */

import { DefaultStreamDataSource, getAnalyticsService } from "./analytics.service";
import { withExecutionTimeout } from "./query-guard";
import { getCampaignHealthAssessment, getCampaignRiskAssessment, getCampaignVerificationSummary, queryCampaigns } from "@/services/campaign.service";
import type { CampaignDataSource, CampaignQueryInput } from "@/services/campaign.service";
import { getCampaignSequelService } from "@/services/campaign-sequel.service";
import { getCampaignAnalyticsDashboard } from "@/services/campaign-analytics-dashboard.service";
import { getGrantProgramService } from "@/services/grant-program.service";
import { getCampaignExportService } from "@/services/campaign-export.service";
import { getCampaignSearchService } from "@/services/campaign-search.service";
import { getCampaignWebhookService } from "@/services/campaign-webhook.service";
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

/**
 * Require an authenticated account id for account-scoped resolvers.
 * Throws an explicit authorization error when the context is anonymous.
 */
function requireAccountId(ctx: ResolverContext): string {
  if (!ctx.accountId) {
    throw new Error("UNAUTHENTICATED: an authenticated account is required");
  }
  return ctx.accountId;
}

/**
 * Require the `admin` role for operator-only mutations (issue #230).
 */
function requireAdmin(ctx: ResolverContext): string {
  const accountId = requireAccountId(ctx);
  if (!ctx.roles || !ctx.roles.includes("admin")) {
    throw new Error("FORBIDDEN: operator role 'admin' is required");
  }
  return accountId;
}

/**
 * Map a campaign export job to its public GraphQL shape. The artifact URL is
 * only exposed once the job has completed; FAILED/EXPIRED jobs surface their
 * terminal state and error message so clients can react explicitly.
 */
function toCampaignExportJobPayload(job: import("@/services/campaign-export.service").CampaignExportJob) {
  const isTerminal = job.status === "COMPLETED" || job.status === "FAILED" || job.status === "EXPIRED";
  return {
    id: job.id,
    campaignId: job.campaignId,
    status: job.status,
    progress: job.progress,
    format: job.format,
    artifactUrl: job.status === "COMPLETED" ? job.artifactUrl ?? null : null,
    error: job.error ?? null,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: Math.floor(job.createdAt / 1000),
    updatedAt: Math.floor(job.updatedAt / 1000),
    expiresAt: job.expiresAt ? Math.floor(job.expiresAt / 1000) : null,
    completedAt: job.completedAt ? Math.floor(job.completedAt / 1000) : null,
    isTerminal,
  };
}

/**
 * Map a webhook redelivery attempt to its public GraphQL shape (issue #230).
 */
function toWebhookRedeliveryPayload(attempt: import("@/services/campaign-webhook.service").WebhookRedeliveryAttempt) {
  return {
    id: attempt.id,
    eventId: attempt.eventId,
    subscriptionId: attempt.subscriptionId,
    status: attempt.status,
    attemptNumber: attempt.attemptNumber,
    requestedBy: attempt.requestedBy,
    responseStatus: attempt.responseStatus ?? null,
    error: attempt.error ?? null,
    createdAt: Math.floor(attempt.createdAt / 1000),
    completedAt: attempt.completedAt ? Math.floor(attempt.completedAt / 1000) : null,
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
       * Fetch the status of a large campaign export job (issue #228).
       *
       * Jobs are scoped to the requesting account: a job owned by another
       * account is reported as NOT_FOUND rather than leaking its existence.
       * FAILED and EXPIRED jobs are returned with their terminal state and
       * error so clients can surface recovery options.
       */
      campaignExportJob: async (
        _: unknown,
        rawArgs: { id: string },
        ctx: ResolverContext,
      ) => {
        const args = guard<typeof rawArgs>("Query.campaignExportJob", ctx, rawArgs, "id");
        const accountId = requireAccountId(ctx);
        const job = await getCampaignExportService().getJob(accountId, args.id);
        if (!job) {
          throw new Error(`NOT_FOUND: campaign export job ${args.id} not found`);
        }
        return toCampaignExportJobPayload(job);
      },

      /**
       * Bounded batch read for campaign discovery (issue #231).
       *
       * `ids` is capped at the service's maximum batch size; exceeding the cap
       * is rejected up front so a single request cannot drive unbounded cost.
       * Missing or unauthorized campaigns are reported per-id in `errors`
       * rather than failing the whole batch.
       */
      campaignDiscoveryBatch: async (
        _: unknown,
        rawArgs: { ids: string[]; network?: Network },
        ctx: ResolverContext,
      ) => {
        const args = guard<typeof rawArgs>("Query.campaignDiscoveryBatch", ctx, rawArgs, "ids");
        if (!Array.isArray(args.ids) || args.ids.length === 0) {
          throw new Error("BAD_USER_INPUT: ids must be a non-empty list");
        }
        const service = getCampaignSearchService(ctx.campaignDataSource);
        if (args.ids.length > service.maxBatchSize) {
          throw new Error(
            `BAD_USER_INPUT: ids exceeds maximum batch size of ${service.maxBatchSize}`,
          );
        }
        const result = await service.searchBatch(args.ids, { network: args.network });
        return {
          items: result.items.map(toCampaignPayload),
          errors: result.errors.map((error) => ({
            id: error.id,
            code: error.code,
            message: error.message,
          })),
        };
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
       * Enqueue a large campaign export as an asynchronous job (issue #228).
       *
       * The job is owned by the requesting account; progress, expiry and
       * retry state are exposed via `campaignExportJob`.
       */
      enqueueCampaignExport: async (
        _: unknown,
        rawArgs: { campaignId: string; format?: "CSV" | "JSON" },
        ctx: ResolverContext,
      ) => {
        const args = guard<typeof rawArgs>("Mutation.enqueueCampaignExport", ctx, rawArgs, "campaignId");
        const accountId = requireAccountId(ctx);
        const job = await getCampaignExportService().enqueueExport(accountId, {
          campaignId: args.campaignId,
          format: args.format,
        });
        return toCampaignExportJobPayload(job);
      },

      /**
       * Operator-initiated webhook redelivery (issue #230).
       *
       * Requires the `admin` role. The original event payload and signature
       * inputs are preserved; each authorized attempt is recorded and
       * returned so operators have an audit trail.
       */
      redeliverWebhook: async (
        _: unknown,
        rawArgs: { eventId: string },
        ctx: ResolverContext,
      ) => {
        const args = guard<typeof rawArgs>("Mutation.redeliverWebhook", ctx, rawArgs, "eventId");
        const accountId = requireAdmin(ctx);
        const attempt = await getCampaignWebhookService().redeliverEvent(accountId, args.eventId);
        return toWebhookRedeliveryPayload(attempt);
      },
    },
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