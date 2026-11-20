import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

export interface SponsorEvent {
  id: string;
  sponsorId: string; // The sponsor receiving the email
  event: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface SponsorTimezone {
  sponsorId: string;
  timezone: string; // e.g., 'America/New_York'
  email: string;
}

/**
 * Version of the campaign aggregate reducer. Bump this whenever the reducer
 * semantics change so persisted aggregates can be detected as stale and
 * rebuilt deterministically.
 */
export const AGGREGATE_VERSION = 1;

export interface CampaignAggregate {
  sponsorId: string;
  campaignId: string;
  /** Total number of unique events applied to this aggregate. */
  totalEvents: number;
  /** Per-event-type counts (e.g. { sent: 3, opened: 1 }). */
  counts: Record<string, number>;
  /** Ids of events already applied, used for idempotent incremental updates. */
  appliedEventIds: string[];
  /** Version of the reducer that produced this aggregate. */
  aggregateVersion: number;
  /** Cursor: id of the last event processed by the incremental reducer. */
  lastProcessedEventId: string | null;
  /** ISO timestamp of the last successful incremental update. */
  updatedAt: string;
}

export interface ReconciliationResult {
  sponsorId: string;
  campaignId: string;
  status: 'ok' | 'drift_repaired' | 'drift_unrepaired';
  incrementalTotal: number;
  recomputedTotal: number;
  repaired: boolean;
  attempts: number;
  error?: string;
}

export interface RebuildAuthorization {
  actorId: string;
  roles: string[];
}

export class AggregateAuthorizationError extends Error {
  constructor(message = 'Not authorized to rebuild campaign aggregates') {
    super(message);
    this.name = 'AggregateAuthorizationError';
  }
}

export class AggregateReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AggregateReconciliationError';
  }
}

const REBUILD_ALLOWED_ROLES = ['admin', 'aggregate-operator'];

export class EventAggregatorService {
  private readonly eventsPath: string;
  private readonly timezonesPath: string;
  private readonly aggregatesPath: string;

  constructor(options: { dataDir?: string } = {}) {
    const dataDir = options.dataDir ?? path.join(process.cwd(), 'data');
    this.eventsPath = path.join(dataDir, 'sponsor_events.json');
    this.timezonesPath = path.join(dataDir, 'sponsor_timezones.json');
    this.aggregatesPath = path.join(dataDir, 'campaign_aggregates.json');
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
      return JSON.parse(data) as SponsorEvent[];
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ENOENT') return [];
      throw err;
    }
  }

  async logEvent(sponsorId: string, event: string, payload: Record<string, unknown>): Promise<SponsorEvent> {
    const events = await this.getEvents();
    const newEvent: SponsorEvent = {
      id: 'evt_' + randomUUID().replace(/-/g, '').slice(0, 16),
      sponsorId,
      event,
      payload,
      timestamp: new Date().toISOString(),
    };
    events.push(newEvent);
    await this.writeJsonAtomic(this.eventsPath, events);
    await this.applyEventToAggregates(newEvent);
    return newEvent;
  }

  async clearEventsForSponsor(sponsorId: string): Promise<void> {
    const events = await this.getEvents();
    const remainingEvents = events.filter((e) => e.sponsorId !== sponsorId);
    await this.writeJsonAtomic(this.eventsPath, remainingEvents);
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
