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
  /** Canonical mapping state; `unknown` events are retained, not dropped. */
  state: CanonicalEventState;
  /** Canonical projection of the event payload. */
  projection: CanonicalEventProjection;
  /** Reason the event was classified as unknown, when applicable. */
  reason?: string;
}

export interface SponsorTimezone {
  sponsorId: string;
  timezone: string; // e.g., 'America/New_York'
  email: string;
}

export class EventAggregatorService {
  private readonly eventsPath: string;
  private readonly timezonesPath: string;

  constructor(options: { dataDir?: string } = {}) {
    const dataDir = options.dataDir ?? path.join(process.cwd(), 'data');
    this.eventsPath = path.join(dataDir, 'sponsor_events.json');
    this.timezonesPath = path.join(dataDir, 'sponsor_timezones.json');
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

  async logEvent(sponsorId: string, event: string, payload: Record<string, unknown>): Promise<SponsorEvent> {
    const events = await this.getEvents();
    const mapping = mapContractEvent(event, payload);
    const newEvent: SponsorEvent = {
      id: 'evt_' + randomUUID().replace(/-/g, '').slice(0, 16),
      sponsorId,
      event,
      payload: payload ?? {},
      timestamp: new Date().toISOString(),
      state: mapping.state,
      projection: mapping.projection,
      ...(mapping.reason ? { reason: mapping.reason } : {}),
    };
    events.push(newEvent);
    await this.writeJsonAtomic(this.eventsPath, events);
    return newEvent;
  }

  /** Return only events that could not be mapped to a canonical projection. */
  async getUnknownEvents(): Promise<SponsorEvent[]> {
    const events = await this.getEvents();
    return events.filter((e) => e.state === 'unknown');
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
}
