import { describe, it, expect } from "vitest";
import {
  RetentionManager,
  RetentionPolicy,
  RetentionError,
  DEFAULT_RETENTION_RULES,
  type PersonalDataCategory,
  type PersonalRecord,
  type DeletionRequest,
  type RetentionClock,
  type RetentionIdGenerator,
} from "../retention.js";
import { AuditLogger } from "../audit.js";
import type {
  Clock as AuditClock,
  IdGenerator as AuditIdGenerator,
} from "../audit.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function record(overrides: Partial<PersonalRecord> = {}): PersonalRecord {
  return {
    id: "rec-1",
    category: "tax",
    subjectId: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB72X",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const NOW = "2025-01-01T00:00:00.000Z";

class FixedClock implements RetentionClock {
  constructor(private value: string) {}
  now(): string {
    return this.value;
  }
}

// ── DEFAULT_RETENTION_RULES ────────────────────────────────────────────────

describe("DEFAULT_RETENTION_RULES", () => {
  it("defines a rule for each personal-data category", () => {
    const categories = DEFAULT_RETENTION_RULES.map((r) => r.category);
    expect(categories).toContain("tax");
    expect(categories).toContain("verification");
    expect(categories).toContain("upload_metadata");
  });

  it("uses longer retention for tax than upload metadata", () => {
    const tax = DEFAULT_RETENTION_RULES.find((r) => r.category === "tax")!;
    const upload = DEFAULT_RETENTION_RULES.find(
      (r) => r.category === "upload_metadata"
    )!;
    expect(tax.retentionDays).toBeGreaterThan(upload.retentionDays);
  });

  // ── RetentionPolicy ────────────────────────────────────────────────────────

  describe("RetentionPolicy", () => {
    it("resolves the default rule for each category", () => {
      const policy = new RetentionPolicy();
      expect(policy.getRule("tax").retentionDays).toBe(2555);
      expect(policy.getRule("verification").retentionDays).toBe(1095);
      expect(policy.getRule("upload_metadata").retentionDays).toBe(90);
    });

    it("allows overriding a rule via setRule", () => {
      const policy = new RetentionPolicy();
      policy.setRule({
        category: "upload_metadata",
        retentionDays: 30,
        description: "custom",
      });
      expect(policy.getRule("upload_metadata").retentionDays).toBe(30);
    });

    it("throws UNKNOWN_CATEGORY for a category without a rule", () => {
      const policy = new RetentionPolicy([]);
      expect(() => policy.getRule("tax")).toThrowError(RetentionError);
      try {
        policy.getRule("tax");
      } catch (err) {
        expect((err as RetentionError).code).toBe("UNKNOWN_CATEGORY");
      }
    });

    it("reports a record past retention as eligible", () => {
      const policy = new RetentionPolicy();
      const past = record({
        category: "upload_metadata",
        updatedAt: "2024-09-23T00:00:00.000Z",
      });
      expect(policy.isPastRetention(past, NOW)).toBe(true);
    });

    it("reports a record within retention as not eligible", () => {
      const policy = new RetentionPolicy();
      const recent = record({
        category: "upload_metadata",
        updatedAt: "2024-12-22T00:00:00.000Z",
      });
      expect(policy.isPastRetention(recent, NOW)).toBe(false);
    });

    it("treats the exact retention boundary as not past retention", () => {
      const policy = new RetentionPolicy();
      const boundary = record({
        category: "upload_metadata",
        updatedAt: "2024-10-03T00:00:00.000Z",
      });
      expect(policy.isPastRetention(boundary, NOW)).toBe(false);
    });

    it("evaluates only the records past retention", () => {
      const policy = new RetentionPolicy();
      const records = [
        record({
          id: "old",
          category: "upload_metadata",
          updatedAt: "2024-09-01T00:00:00.000Z",
        }),
        record({
          id: "new",
          category: "upload_metadata",
          updatedAt: "2024-12-31T00:00:00.000Z",
        }),
      ];
      const eligible = policy.evaluateRetention(records, NOW);
      expect(eligible).toHaveLength(1);
      expect(eligible[0].id).toBe("old");
    });
  });

  // ── RetentionManager ─────────────────────────────────────────────────────

  describe("RetentionManager", () => {
    it("stores and retrieves a personal record", () => {
      const manager = new RetentionManager();
      manager.addRecord(record({ id: "rec-a" }));
      expect(manager.getRecord("rec-a")?.id).toBe("rec-a");
      expect(manager.getRecord("missing")).toBeUndefined();
      expect(manager.listRecords()).toHaveLength(1);
    });

    it("deletes a record past retention and audits it (success)", () => {
      const logger = new AuditLogger();
      const manager = new RetentionManager({
        logger,
        clock: new FixedClock(NOW),
      });
      const old = record({
        id: "rec-old",
        category: "upload_metadata",
        updatedAt: "2024-09-01T00:00:00.000Z",
      });
      manager.addRecord(old);

      const deletion = manager.scheduleDeletion("rec-old", {
        reason: "GDPR erasure request",
        actor: "GADMIN...",
        requestId: "req-del-1",
      });

      expect(deletion.action).toBe("DELETE");
      expect(deletion.category).toBe("upload_metadata");
      expect(deletion.subjectId).toBe(old.subjectId);
      expect(deletion.emergencyOverride).toBe(false);
      expect(manager.getRecord("rec-old")).toBeUndefined();
      expect(manager.listDeletions()).toHaveLength(1);

      // The deletion is audited; no secrets in the audit entry.
      const audit = logger.findByAction("delete.personal_record");
      expect(audit).toHaveLength(1);
      expect(audit[0].actor).toBe("GADMIN...");
      expect(audit[0].requestId).toBe("req-del-1");
      expect(JSON.stringify(audit[0])).not.toContain("secret");
    });

    it("rejects deletion of a record not past retention", () => {
      const manager = new RetentionManager({ clock: new FixedClock(NOW) });
      manager.addRecord(
        record({ id: "rec-recent", updatedAt: "2024-12-31T00:00:00.000Z" })
      );

      expect(() =>
        manager.scheduleDeletion("rec-recent", {
          reason: "premature",
          actor: "GADMIN...",
          requestId: "req-del-2",
        })
      ).toThrowError(RetentionError);
      try {
        manager.scheduleDeletion("rec-recent", {
          reason: "premature",
          actor: "GADMIN...",
          requestId: "req-del-2",
        });
      } catch (err) {
        expect((err as RetentionError).code).toBe("NOT_PAST_RETENTION");
      }
      // Record must still exist.
      expect(manager.getRecord("rec-recent")).toBeDefined();
      expect(manager.listDeletions()).toHaveLength(0);
    });

    it("allows emergency override to delete a record not past retention", () => {
      const manager = new RetentionManager({ clock: new FixedClock(NOW) });
      manager.addRecord(
        record({ id: "rec-recent", updatedAt: "2024-12-31T00:00:00.000Z" })
      );

      const deletion = manager.scheduleDeletion("rec-recent", {
        reason: "legal hold override",
        actor: "GADMIN...",
        requestId: "req-del-3",
        emergencyOverride: true,
      });

      expect(deletion.emergencyOverride).toBe(true);
      expect(manager.getRecord("rec-recent")).toBeUndefined();
      expect(manager.listDeletions()).toHaveLength(1);
    });

    it("throws RECORD_NOT_FOUND for a missing record", () => {
      const manager = new RetentionManager();
      expect(() =>
        manager.scheduleDeletion("does-not-exist", {
          reason: "x",
          actor: "GADMIN...",
          requestId: "req-del-4",
        })
      ).toThrowError(RetentionError);
      try {
        manager.scheduleDeletion("does-not-exist", {
          reason: "x",
          actor: "GADMIN...",
          requestId: "req-del-4",
        });
      } catch (err) {
        expect((err as RetentionError).code).toBe("RECORD_NOT_FOUND");
      }
    });

    it("lists eligible records without mutating state", () => {
      const manager = new RetentionManager({ clock: new FixedClock(NOW) });
      manager.addRecord(
        record({
          id: "old",
          category: "upload_metadata",
          updatedAt: "2024-09-01T00:00:00.000Z",
        })
      );
      manager.addRecord(
        record({
          id: "new",
          category: "upload_metadata",
          updatedAt: "2024-12-31T00:00:00.000Z",
        })
      );

      const eligible = manager.eligibleForDeletion(NOW);
      expect(eligible).toHaveLength(1);
      expect(eligible[0].id).toBe("old");
      // State unchanged.
      expect(manager.listRecords()).toHaveLength(2);
    });

    it("purges old deletion records and returns the count", () => {
      const manager = new RetentionManager({ clock: new FixedClock(NOW) });
      manager.addRecord(
        record({
          id: "r1",
          category: "upload_metadata",
          updatedAt: "2024-01-01T00:00:00.000Z",
        })
      );
      manager.addRecord(
        record({
          id: "r2",
          category: "upload_metadata",
          updatedAt: "2024-01-01T00:00:00.000Z",
        })
      );
      manager.scheduleDeletion("r1", {
        reason: "a",
        actor: "x",
        requestId: "q1",
      });
      manager.scheduleDeletion("r2", {
        reason: "b",
        actor: "x",
        requestId: "q2",
      });

      const removed = manager.purgeDeletionRecordsOlderThan(
        "2025-01-02T00:00:00.000Z",
        "admin",
        "req-purge"
      );
      expect(removed).toBe(2);
      expect(manager.listDeletions()).toHaveLength(0);
    });
  });
});
