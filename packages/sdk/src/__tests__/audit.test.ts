import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AuditLogger,
  AccessController,
  PrivilegedActionRecorder,
  AuditError,
  DEFAULT_ACCESS_POLICY,
  sanitizeMetadata,
  type ActorRole,
  type AuditAction,
  type AuditEventInput,
  type Clock,
  type IdGenerator,
} from "../audit.js";

// ── Deterministic test doubles ─────────────────────────────────────────────

class FixedClock implements Clock {
  constructor(private value: string) {}
  now(): string {
    return this.value;
  }
}

class FixedIdGenerator implements IdGenerator {
  private counter = 0;
  next(): string {
    return `audit-test-${++this.counter}`;
  }
}

function makeLogger(clockValue = "2025-01-01T00:00:00.000Z") {
  return new AuditLogger({
    idGenerator: new FixedIdGenerator(),
    clock: new FixedClock(clockValue),
  });
}

function baseInput(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    actor: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB72X",
    actorRole: "admin",
    action: "deploy.contract",
    target: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    requestId: "req-001",
    ...overrides,
  };
}

// ── sanitizeMetadata ───────────────────────────────────────────────────────

describe("sanitizeMetadata", () => {
  it("keeps ordinary metadata untouched", () => {
    expect(sanitizeMetadata({ campaignId: "camp-1", amount: "1000" })).toEqual({
      campaignId: "camp-1",
      amount: "1000",
    });
  });

  it("redacts secret-looking keys", () => {
    expect(
      sanitizeMetadata({
        apiKey: "abc123",
        SECRET: "s3cr3t",
        privateKey: "-----BEGIN-----",
        password: "p@ss",
      })
    ).toEqual({
      apiKey: "[REDACTED]",
      SECRET: "[REDACTED]",
      privateKey: "[REDACTED]",
      password: "[REDACTED]",
    });
  });

  it("redacts values that look like Stellar secret keys", () => {
    // A Stellar secret key is a 56-character string starting with 'S'.
    const secretKey = "S" + "A".repeat(54) + "Y";
    expect(secretKey).toHaveLength(56);
    expect(sanitizeMetadata({ fundingKey: secretKey })).toEqual({
      fundingKey: "[REDACTED]",
    });
  });

  it("returns an empty object for undefined input", () => {
    expect(sanitizeMetadata(undefined)).toEqual({});
  });

  // ── DEFAULT_ACCESS_POLICY / AccessController ──────────────────────────────

  describe("DEFAULT_ACCESS_POLICY", () => {
    it("allows admins every privileged action", () => {
      const actions: AuditAction[] = [
        "deploy.contract",
        "initialize.contract",
        "rotate.credential",
        "delete.personal_record",
        "export.personal_data",
        "modify.retention_policy",
      ];
      for (const action of actions) {
        expect(DEFAULT_ACCESS_POLICY.can("admin", action)).toBe(true);
      }
    });

    it("allows operators a subset of privileged actions", () => {
      expect(DEFAULT_ACCESS_POLICY.can("operator", "deploy.contract")).toBe(
        true
      );
      expect(
        DEFAULT_ACCESS_POLICY.can("operator", "delete.personal_record")
      ).toBe(true);
      expect(
        DEFAULT_ACCESS_POLICY.can("operator", "export.personal_data")
      ).toBe(false);
      expect(
        DEFAULT_ACCESS_POLICY.can("operator", "modify.retention_policy")
      ).toBe(false);
    });

    it("denies auditors and viewers all write actions", () => {
      for (const role of ["auditor", "viewer"] as ActorRole[]) {
        for (const action of [
          "deploy.contract",
          "delete.personal_record",
        ] as AuditAction[]) {
          expect(DEFAULT_ACCESS_POLICY.can(role, action)).toBe(false);
        }
      }
    });
  });

  describe("AccessController", () => {
    it("reports allowed and denied roles", () => {
      const controller = new AccessController();
      expect(controller.isAllowed("admin", "deploy.contract")).toBe(true);
      expect(controller.isAllowed("viewer", "deploy.contract")).toBe(false);
    });

    it("throws ACCESS_DENIED on enforce for unauthorized roles", () => {
      const controller = new AccessController();
      expect(() =>
        controller.enforce("viewer", "delete.personal_record")
      ).toThrowError(AuditError);
      try {
        controller.enforce("viewer", "delete.personal_record");
      } catch (err) {
        expect((err as AuditError).code).toBe("ACCESS_DENIED");
        expect((err as AuditError).message).toContain("not authorized");
      }
    });
  });

  // ── AuditLogger ────────────────────────────────────────────────────────────

  describe("AuditLogger", () => {
    it("records an allowed event with assigned id and timestamp", () => {
      const logger = makeLogger();
      const record = logger.record(baseInput());

      expect(record.id).toBe("audit-test-1");
      expect(record.timestamp).toBe("2025-01-01T00:00:00.000Z");
      expect(record.outcome).toBe("ALLOWED");
      expect(record.requestId).toBe("req-001");
      expect(logger.count()).toBe(1);
    });

    it("records denials with an explicit outcome", () => {
      const logger = makeLogger();
      logger.record({
        ...baseInput(),
        outcome: "DENIED",
        reason: "insufficient rights",
      });

      const denied = logger.findByAction("deploy.contract");
      expect(denied).toHaveLength(1);
      expect(denied[0].outcome).toBe("DENIED");
      expect(denied[0].reason).toBe("insufficient rights");
    });

    it("lists records newest first", () => {
      const logger = makeLogger();
      logger.record(baseInput({ requestId: "req-1" }));
      logger.record(baseInput({ requestId: "req-2" }));
      const listed = logger.list();
      expect(listed).toHaveLength(2);
      expect(listed[0].requestId).toBe("req-2");
      expect(listed[1].requestId).toBe("req-1");
    });

    it("finds records by actor, action, target, and request id", () => {
      const logger = makeLogger();
      logger.record(
        baseInput({
          actor: "actor-a",
          action: "deploy.contract",
          requestId: "req-a",
        })
      );
      logger.record(
        baseInput({
          actor: "actor-b",
          action: "delete.personal_record",
          requestId: "req-b",
        })
      );

      expect(logger.findByActor("actor-a")).toHaveLength(1);
      expect(logger.findByAction("delete.personal_record")).toHaveLength(1);
      expect(logger.findByTarget("nope")).toHaveLength(0);
      expect(logger.findByRequestId("req-a")).toHaveLength(1);
      expect(logger.findByRequestId("req-b")).toHaveLength(1);
    });

    it("purges records older than the cutoff and audits the purge", () => {
      const oldLogger = makeLogger("2024-01-01T00:00:00.000Z");
      oldLogger.record(baseInput({ requestId: "old-1" }));

      const newLogger = makeLogger("2025-06-01T00:00:00.000Z");
      newLogger.record(baseInput({ requestId: "new-1" }));

      // Each logger has a single entry; verify cutoff semantics on each.
      expect(
        oldLogger.purgeOlderThan("2025-01-01T00:00:00.000Z", "admin", "purge-1")
      ).toBe(1);
      expect(oldLogger.count()).toBe(1); // only the purge audit entry remains

      expect(
        newLogger.purgeOlderThan("2026-01-01T00:00:00.000Z", "admin", "purge-1")
      ).toBe(1);
      expect(newLogger.count()).toBe(1);

      const purgeEntries = oldLogger.findByAction("modify.retention_policy");
      expect(purgeEntries).toHaveLength(1);
      expect(purgeEntries[0].metadata?.["removedCount"]).toBe(1);
    });

    it("throws INVALID_CUTOFF for a bad cutoff timestamp", () => {
      const logger = makeLogger();
      expect(() =>
        logger.purgeOlderThan("not-a-date", "admin", "purge-1")
      ).toThrowError(AuditError);
    });
  });

  // ── PrivilegedActionRecorder ─────────────────────────────────────────────

  describe("PrivilegedActionRecorder", () => {
    it("executes and audits an allowed privileged action", async () => {
      const recorder = new PrivilegedActionRecorder(
        new AccessController(),
        makeLogger()
      );
      const result = await recorder.execute(
        baseInput(),
        async () => "contract-deployed"
      );

      expect(result).toBe("contract-deployed");
      const logs = recorder.getLogger().list();
      expect(logs).toHaveLength(1);
      expect(logs[0].outcome).toBe("ALLOWED");
      expect(logs[0].actor).toBe(baseInput().actor);
      expect(logs[0].requestId).toBe("req-001");
    });

    it("audits and throws when the actor lacks permission (negative test)", async () => {
      const recorder = new PrivilegedActionRecorder(
        new AccessController(),
        makeLogger()
      );

      await expect(
        recorder.execute(
          { ...baseInput(), actorRole: "viewer" },
          async () => "should-not-run"
        )
      ).rejects.toThrowError(AuditError);

      const logs = recorder.getLogger().findByAction("deploy.contract");
      expect(logs).toHaveLength(1);
      expect(logs[0].outcome).toBe("DENIED");
      expect(logs[0].actorRole).toBe("viewer");
    });

    it("audits failures as DENIED and rethrows", async () => {
      const recorder = new PrivilegedActionRecorder(
        new AccessController(),
        makeLogger()
      );

      await expect(
        recorder.execute(baseInput(), async () => {
          throw new Error("contract call failed");
        })
      ).rejects.toThrow("contract call failed");

      const logs = recorder.getLogger().findByAction("deploy.contract");
      expect(logs).toHaveLength(1);
      expect(logs[0].outcome).toBe("DENIED");
      expect(logs[0].reason).toBe("contract call failed");
    });

    it("redacts secrets from metadata even for allowed actions", async () => {
      const recorder = new PrivilegedActionRecorder(
        new AccessController(),
        makeLogger()
      );
      const secretKey =
        "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY";
      await recorder.execute(
        {
          ...baseInput(),
          action: "rotate.credential",
          metadata: { credentialId: "cred-1", secretKey },
        },
        async () => "rotated"
      );

      const logs = recorder.getLogger().list();
      expect(logs[0].metadata?.["secretKey"]).toBe("[REDACTED]");
      expect(logs[0].metadata?.["credentialId"]).toBe("cred-1");
    });
  });
});
