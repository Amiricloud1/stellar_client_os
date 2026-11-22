import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

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
      return JSON.parse(data) as SponsorEvent[];
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
    const newEvent: SponsorEvent = {
      id: 'evt_' + randomUUID().replace(/-/g, '').slice(0, 16),
      sponsorId,
      event,
      payload,
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
}
