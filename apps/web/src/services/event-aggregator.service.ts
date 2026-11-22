import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

/**
 * Canonical contract-event domain mappings.
 *
 * Supported event versions are mapped to a canonical projection. Unknown or
 * malformed events are NOT dropped: they are retained verbatim in storage and
 * surfaced with an explicit `unknown` state so operators can inspect them.
 */
export type CanonicalEventState = 'supported' | 'unknown';

export interface CanonicalEventProjection {
  /** Canonical domain name, e.g. `sponsor.created`. */
  domain: string;
  /** Canonical schema version for the projection. */
  version: number;
  /** Projected fields for supported events; raw payload for unknown ones. */
  fields: Record<string, unknown>;
}

export interface CanonicalEventMapping {
  state: CanonicalEventState;
  /** Canonical event name (or the raw event name when unknown). */
  event: string;
  projection: CanonicalEventProjection;
  /** Reason the event was classified as unknown, when applicable. */
  reason?: string;
}

interface SupportedEventDefinition {
  domain: string;
  version: number;
  project: (payload: Record<string, unknown>) => Record<string, unknown>;
}

const SUPPORTED_EVENTS: Record<string, SupportedEventDefinition> = {
  'sponsor.created:v1': {
    domain: 'sponsor.created',
    version: 1,
    project: (payload) => ({
      sponsorId: payload.sponsorId,
      name: payload.name,
      email: payload.email,
    }),
  },
  'sponsor.updated:v1': {
    domain: 'sponsor.updated',
    version: 1,
    project: (payload) => ({
      sponsorId: payload.sponsorId,
      changes: payload.changes ?? {},
    }),
  },
  'sponsor.deleted:v1': {
    domain: 'sponsor.deleted',
    version: 1,
    project: (payload) => ({
      sponsorId: payload.sponsorId,
    }),
  },
};

/**
 * Map a raw event name + payload to a canonical projection.
 *
 * - Supported `name:vN` events are projected into their canonical domain.
 * - Unknown versions/names and malformed payloads are retained verbatim and
 *   marked `unknown` with an explanatory reason.
 */
export function mapContractEvent(
  event: string,
  payload: Record<string, unknown> | null | undefined,
): CanonicalEventMapping {
  const safePayload: Record<string, unknown> =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : {};

  const definition = SUPPORTED_EVENTS[event];
  if (!definition) {
    return {
      state: 'unknown',
      event,
      reason: 'unsupported_event_version',
      projection: { domain: event, version: 0, fields: safePayload },
    };
  }

  if (payload === null || payload === undefined || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      state: 'unknown',
      event,
      reason: 'malformed_payload',
      projection: { domain: definition.domain, version: definition.version, fields: safePayload },
    };
  }

  return {
    state: 'supported',
    event,
    projection: {
      domain: definition.domain,
      version: definition.version,
      fields: definition.project(safePayload),
    },
  };
}

export interface SponsorEvent {
  id: string;
  sponsorId: string; // The sponsor receiving the email
  event: string;
  payload: Record<string, unknown>;
  timestamp: string;
  network?: string; // Network the event originated from (e.g., 'mainnet', 'testnet')
  deploymentId?: string; // Deployment that produced the event
}

export interface SponsorTimezone {
  sponsorId: string;
  timezone: string; // e.g., 'America/New_York'
  email: string;
}

/**
 * Identifies a single ingestion partition. Events, cursors, and health are
 * tracked independently per (network, deploymentId) pair so that a stalled
 * source in one deployment cannot block ingestion for any other deployment.
 */
export interface IngestionPartition {
  network: string;
  deploymentId: string;
}

export type PartitionHealthStatus = 'healthy' | 'stalled' | 'recovering';

export interface PartitionHealth {
  network: string;
  deploymentId: string;
  status: PartitionHealthStatus;
  lastEventAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  updatedAt: string;
}

export interface PartitionCursor {
  network: string;
  deploymentId: string;
  cursor: string | null;
  updatedAt: string;
}

export class EventAggregatorService {
  private readonly eventsPath: string;
  private readonly timezonesPath: string;
  private readonly cursorsPath: string;
  private readonly healthPath: string;

  constructor(options: { dataDir?: string } = {}) {
    const dataDir = options.dataDir ?? path.join(process.cwd(), 'data');
    this.eventsPath = path.join(dataDir, 'sponsor_events.json');
    this.timezonesPath = path.join(dataDir, 'sponsor_timezones.json');
    this.cursorsPath = path.join(dataDir, 'ingestion_cursors.json');
    this.healthPath = path.join(dataDir, 'ingestion_health.json');
  }

  private static partitionKey(partition: IngestionPartition): string {
    return `${partition.network}::${partition.deploymentId}`;
  }

  private static assertPartition(partition: IngestionPartition): void {
    if (!partition || typeof partition.network !== 'string' || partition.network.length === 0) {
      throw new Error('Ingestion partition requires a non-empty network');
    }
    if (typeof partition.deploymentId !== 'string' || partition.deploymentId.length === 0) {
      throw new Error('Ingestion partition requires a non-empty deploymentId');
    }
  }

  private async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tempPath, filePath);
    } catch (err) {
      try {
        await fs.unlink(tempPath);
      } catch {}
      throw err;
    }
  }

  async getEvents(): Promise<SponsorEvent[]> {
    try {
      const data = await fs.readFile(this.eventsPath, 'utf-8');
      const raw = JSON.parse(data) as Array<Partial<SponsorEvent> & { event: string; payload?: Record<string, unknown> }>;
      // Backfill canonical mapping for events persisted before the mapping layer.
      return raw.map((entry) => {
        if (entry.state && entry.projection) return entry as SponsorEvent;
        const mapping = mapContractEvent(entry.event, entry.payload);
        return {
          id: entry.id ?? 'evt_' + randomUUID().replace(/-/g, '').slice(0, 16),
          sponsorId: entry.sponsorId ?? '',
          event: entry.event,
          payload: entry.payload ?? {},
          timestamp: entry.timestamp ?? new Date().toISOString(),
          state: mapping.state,
          projection: mapping.projection,
          ...(mapping.reason ? { reason: mapping.reason } : {}),
        };
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ENOENT') return [];
      throw err;
    }
  }

  async getEventsForPartition(partition: IngestionPartition): Promise<SponsorEvent[]> {
    EventAggregatorService.assertPartition(partition);
    const events = await this.getEvents();
    return events.filter(
      (e) => e.network === partition.network && e.deploymentId === partition.deploymentId,
    );
  }

  async logEvent(
    sponsorId: string,
    event: string,
    payload: Record<string, unknown>,
    partition?: IngestionPartition,
  ): Promise<SponsorEvent> {
    if (partition) EventAggregatorService.assertPartition(partition);
    const events = await this.getEvents();
    const mapping = mapContractEvent(event, payload);
    const newEvent: SponsorEvent = {
      id: 'evt_' + randomUUID().replace(/-/g, '').slice(0, 16),
      sponsorId,
      event,
      payload: payload ?? {},
      timestamp: new Date().toISOString(),
      ...(partition ? { network: partition.network, deploymentId: partition.deploymentId } : {}),
    };
    events.push(newEvent);
    await this.writeJsonAtomic(this.eventsPath, events);
    if (partition) {
      await this.recordPartitionSuccess(partition, newEvent.timestamp);
    }
    return newEvent;
  }

  async clearEventsForSponsor(sponsorId: string, partition?: IngestionPartition): Promise<void> {
    if (partition) EventAggregatorService.assertPartition(partition);
    const events = await this.getEvents();
    const remainingEvents = events.filter((e) => {
      if (e.sponsorId !== sponsorId) return true;
      if (!partition) return false;
      return !(e.network === partition.network && e.deploymentId === partition.deploymentId);
    });
    await this.writeJsonAtomic(this.eventsPath, remainingEvents);
  }

  private async getCursors(): Promise<PartitionCursor[]> {
    try {
      const data = await fs.readFile(this.cursorsPath, 'utf-8');
      return JSON.parse(data) as PartitionCursor[];
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ENOENT') return [];
      throw err;
    }
  }

  async getCursor(partition: IngestionPartition): Promise<string | null> {
    EventAggregatorService.assertPartition(partition);
    const cursors = await this.getCursors();
    const match = cursors.find(
      (c) => c.network === partition.network && c.deploymentId === partition.deploymentId,
    );
    return match?.cursor ?? null;
  }

  async setCursor(partition: IngestionPartition, cursor: string | null): Promise<void> {
    EventAggregatorService.assertPartition(partition);
    const cursors = await this.getCursors();
    const index = cursors.findIndex(
      (c) => c.network === partition.network && c.deploymentId === partition.deploymentId,
    );
    const entry: PartitionCursor = {
      network: partition.network,
      deploymentId: partition.deploymentId,
      cursor,
      updatedAt: new Date().toISOString(),
    };
    if (index >= 0) {
      cursors[index] = entry;
    } else {
      cursors.push(entry);
    }
    await this.writeJsonAtomic(this.cursorsPath, cursors);
  }

  private async getHealthRecords(): Promise<PartitionHealth[]> {
    try {
      const data = await fs.readFile(this.healthPath, 'utf-8');
      return JSON.parse(data) as PartitionHealth[];
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ENOENT') return [];
      throw err;
    }
  }

  private async upsertHealth(record: PartitionHealth): Promise<void> {
    const records = await this.getHealthRecords();
    const index = records.findIndex(
      (r) => r.network === record.network && r.deploymentId === record.deploymentId,
    );
    if (index >= 0) {
      records[index] = record;
    } else {
      records.push(record);
    }
    await this.writeJsonAtomic(this.healthPath, records);
  }

  async getPartitionHealth(partition: IngestionPartition): Promise<PartitionHealth> {
    EventAggregatorService.assertPartition(partition);
    const records = await this.getHealthRecords();
    const match = records.find(
      (r) => r.network === partition.network && r.deploymentId === partition.deploymentId,
    );
    if (match) return match;
    return {
      network: partition.network,
      deploymentId: partition.deploymentId,
      status: 'healthy',
      lastEventAt: null,
      lastError: null,
      consecutiveFailures: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  async getAllPartitionHealth(): Promise<PartitionHealth[]> {
    return this.getHealthRecords();
  }

  async recordPartitionSuccess(partition: IngestionPartition, at?: string): Promise<void> {
    EventAggregatorService.assertPartition(partition);
    const previous = await this.getPartitionHealth(partition);
    await this.upsertHealth({
      network: partition.network,
      deploymentId: partition.deploymentId,
      status: 'healthy',
      lastEventAt: at ?? new Date().toISOString(),
      lastError: null,
      consecutiveFailures: 0,
      updatedAt: new Date().toISOString(),
    });
    // Preserve lastEventAt if a success is recorded without a new event.
    if (!at && previous.lastEventAt) {
      const records = await this.getHealthRecords();
      const index = records.findIndex(
        (r) => r.network === partition.network && r.deploymentId === partition.deploymentId,
      );
      if (index >= 0) {
        records[index].lastEventAt = previous.lastEventAt;
        await this.writeJsonAtomic(this.healthPath, records);
      }
    }
  }

  async recordPartitionFailure(partition: IngestionPartition, error: unknown): Promise<void> {
    EventAggregatorService.assertPartition(partition);
    const previous = await this.getPartitionHealth(partition);
    const message = error instanceof Error ? error.message : String(error);
    await this.upsertHealth({
      network: partition.network,
      deploymentId: partition.deploymentId,
      status: 'stalled',
      lastEventAt: previous.lastEventAt,
      lastError: message,
      consecutiveFailures: previous.consecutiveFailures + 1,
      updatedAt: new Date().toISOString(),
    });
  }

  async markPartitionRecovering(partition: IngestionPartition): Promise<void> {
    EventAggregatorService.assertPartition(partition);
    const previous = await this.getPartitionHealth(partition);
    await this.upsertHealth({
      network: partition.network,
      deploymentId: partition.deploymentId,
      status: 'recovering',
      lastEventAt: previous.lastEventAt,
      lastError: previous.lastError,
      consecutiveFailures: previous.consecutiveFailures,
      updatedAt: new Date().toISOString(),
    });
  }

  async getSponsorTimezones(): Promise<SponsorTimezone[]> {
    try {
      const data = await fs.readFile(this.timezonesPath, 'utf-8');
      return JSON.parse(data) as SponsorTimezone[];
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ENOENT') return [];
      throw err;
    }
  }

  async setSponsorTimezone(sponsorId: string, email: string, timezone: string): Promise<void> {
    const timezones = await this.getSponsorTimezones();
    const index = timezones.findIndex((t) => t.sponsorId === sponsorId);
    if (index >= 0) {
      timezones[index] = { sponsorId, email, timezone };
    } else {
      timezones.push({ sponsorId, email, timezone });
    }
    await this.writeJsonAtomic(this.timezonesPath, timezones);
  }

  // ---------------------------------------------------------------------------
  // Campaign aggregates
  // ---------------------------------------------------------------------------

  async getAggregates(): Promise<CampaignAggregate[]> {
    try {
      const data = await fs.readFile(this.aggregatesPath, 'utf-8');
      return JSON.parse(data) as CampaignAggregate[];
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ENOENT') return [];
      throw err;
    }
  }

  private campaignIdOf(event: SponsorEvent): string {
    const campaignId = event.payload?.campaignId;
    return typeof campaignId === 'string' && campaignId.length > 0 ? campaignId : 'default';
  }

  /**
   * Deterministic reducer: folds a single event into an aggregate. Applying the
   * same event id twice is a no-op, which makes incremental updates idempotent
   * under duplicate delivery.
   */
  private applyEvent(aggregate: CampaignAggregate, event: SponsorEvent): CampaignAggregate {
    if (aggregate.appliedEventIds.includes(event.id)) {
      return aggregate;
    }
    const counts = { ...aggregate.counts };
    counts[event.event] = (counts[event.event] ?? 0) + 1;
    return {
      ...aggregate,
      counts,
      totalEvents: aggregate.totalEvents + 1,
      appliedEventIds: [...aggregate.appliedEventIds, event.id],
      lastProcessedEventId: event.id,
      aggregateVersion: AGGREGATE_VERSION,
      updatedAt: new Date().toISOString(),
    };
  }

  private emptyAggregate(sponsorId: string, campaignId: string): CampaignAggregate {
    return {
      sponsorId,
      campaignId,
      totalEvents: 0,
      counts: {},
      appliedEventIds: [],
      aggregateVersion: AGGREGATE_VERSION,
      lastProcessedEventId: null,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Full deterministic recomputation of an aggregate from the raw event log.
   * Events are sorted by timestamp then id so late-arriving events fold in a
   * stable order regardless of insertion order.
   */
  recomputeAggregate(events: SponsorEvent[], sponsorId: string, campaignId: string): CampaignAggregate {
    const relevant = events
      .filter((e) => e.sponsorId === sponsorId && this.campaignIdOf(e) === campaignId)
      .slice()
      .sort((a, b) => {
        if (a.timestamp === b.timestamp) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        return a.timestamp < b.timestamp ? -1 : 1;
      });

    let aggregate = this.emptyAggregate(sponsorId, campaignId);
    for (const event of relevant) {
      aggregate = this.applyEvent(aggregate, event);
    }
    return aggregate;
  }

  /**
   * Incrementally applies a newly logged event to the persisted aggregates.
   * Idempotent by event id; stale aggregates (older reducer version) are
   * rebuilt from scratch instead of being patched.
   */
  async applyEventToAggregates(event: SponsorEvent): Promise<CampaignAggregate> {
    const aggregates = await this.getAggregates();
    const campaignId = this.campaignIdOf(event);
    const index = aggregates.findIndex(
      (a) => a.sponsorId === event.sponsorId && a.campaignId === campaignId,
    );

    let aggregate: CampaignAggregate;
    if (index < 0) {
      aggregate = this.emptyAggregate(event.sponsorId, campaignId);
    } else if (aggregates[index].aggregateVersion !== AGGREGATE_VERSION) {
      aggregate = this.recomputeAggregate(await this.getEvents(), event.sponsorId, campaignId);
    } else {
      aggregate = aggregates[index];
    }

    aggregate = this.applyEvent(aggregate, event);

    if (index < 0) {
      aggregates.push(aggregate);
    } else {
      aggregates[index] = aggregate;
    }
    await this.writeJsonAtomic(this.aggregatesPath, aggregates);
    return aggregate;
  }

  private assertRebuildAuthorized(auth?: RebuildAuthorization): void {
    if (!auth) throw new AggregateAuthorizationError();
    const allowed = auth.roles.some((r) => REBUILD_ALLOWED_ROLES.includes(r));
    if (!allowed) throw new AggregateAuthorizationError();
  }

  /**
   * Rebuilds all aggregates for a sponsor from the raw event log. Requires an
   * authorized actor (admin or aggregate-operator).
   */
  async rebuildAggregates(
    sponsorId: string,
    auth?: RebuildAuthorization,
  ): Promise<CampaignAggregate[]> {
    this.assertRebuildAuthorized(auth);
    const events = await this.getEvents();
    const campaignIds = new Set<string>();
    for (const e of events) {
      if (e.sponsorId === sponsorId) campaignIds.add(this.campaignIdOf(e));
    }

    const rebuilt: CampaignAggregate[] = [];
    for (const campaignId of campaignIds) {
      rebuilt.push(this.recomputeAggregate(events, sponsorId, campaignId));
    }

    const aggregates = await this.getAggregates();
    const others = aggregates.filter((a) => a.sponsorId !== sponsorId);
    await this.writeJsonAtomic(this.aggregatesPath, [...others, ...rebuilt]);
    return rebuilt;
  }

  /**
   * Reconciliation job: compares incremental totals against a full
   * recomputation and repairs drift. Retries transient write failures up to
   * `maxAttempts` times before surfacing an explicit unrepaired state.
   */
  async reconcileAggregates(
    sponsorId: string,
    options: { auth?: RebuildAuthorization; maxAttempts?: number } = {},
  ): Promise<ReconciliationResult[]> {
    this.assertRebuildAuthorized(options.auth);
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    const events = await this.getEvents();
    const aggregates = await this.getAggregates();
    const sponsorAggregates = aggregates.filter((a) => a.sponsorId === sponsorId);

    const campaignIds = new Set<string>(sponsorAggregates.map((a) => a.campaignId));
    for (const e of events) {
      if (e.sponsorId === sponsorId) campaignIds.add(this.campaignIdOf(e));
    }

    const results: ReconciliationResult[] = [];
    const repairedAggregates: CampaignAggregate[] = [];

    for (const campaignId of campaignIds) {
      const existing = sponsorAggregates.find((a) => a.campaignId === campaignId);
      const recomputed = this.recomputeAggregate(events, sponsorId, campaignId);
      const incrementalTotal = existing?.totalEvents ?? 0;

      const matches =
        existing !== undefined &&
        existing.aggregateVersion === AGGREGATE_VERSION &&
        existing.totalEvents === recomputed.totalEvents &&
        JSON.stringify(existing.counts) === JSON.stringify(recomputed.counts);

      if (matches) {
        results.push({
          sponsorId,
          campaignId,
          status: 'ok',
          incrementalTotal,
          recomputedTotal: recomputed.totalEvents,
          repaired: false,
          attempts: 1,
        });
        repairedAggregates.push(existing);
        continue;
      }

      let attempts = 0;
      let repaired = false;
      let lastError: string | undefined;
      while (attempts < maxAttempts && !repaired) {
        attempts += 1;
        try {
          const current = await this.getAggregates();
          const others = current.filter(
            (a) => !(a.sponsorId === sponsorId && a.campaignId === campaignId),
          );
          await this.writeJsonAtomic(this.aggregatesPath, [...others, recomputed]);
          repaired = true;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      results.push({
        sponsorId,
        campaignId,
        status: repaired ? 'drift_repaired' : 'drift_unrepaired',
        incrementalTotal,
        recomputedTotal: recomputed.totalEvents,
        repaired,
        attempts,
        ...(lastError ? { error: lastError } : {}),
      });
      if (repaired) repairedAggregates.push(recomputed);
    }

    return results;
  }
}
