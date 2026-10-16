import { describe, it, expect } from "vitest";
import {
  consumeContractEvents,
  filterEventsByType,
  groupEventsByContract,
  getStreamDeposits,
  getStreamPauses,
  type EventConsumptionResult,
  type ContractEventRaw,
} from "../../recipes/events.js";

function makeRawEvent(
  contract_id: string,
  topic: string[],
  value: unknown,
): ContractEventRaw {
  return { contract_id, topic, value };
}

describe("consumeContractEvents", () => {
  it("parses valid payment stream events", () => {
    const events: ContractEventRaw[] = [
      makeRawEvent("CAAAA...", ["StreamDeposit"], { amount: 100n, stream_id: 1n }),
      makeRawEvent("CAAAA...", ["StreamPaused"], { paused_at: 5n, stream_id: 1n }),
    ];

    const result: EventConsumptionResult = consumeContractEvents(events);

    expect(result.totalRetrieved).toBe(2);
    expect(result.parsedEvents.length).toBe(2);
    expect(result.unparsedEvents.length).toBe(0);
    expect(result.parsedEvents[0].type).toBe("StreamDeposit");
    expect(result.parsedEvents[1].type).toBe("StreamPaused");
  });

  it("handles empty events array", () => {
    const result = consumeContractEvents([]);
    expect(result.totalRetrieved).toBe(0);
    expect(result.parsedEvents).toEqual([]);
    expect(result.unparsedEvents).toEqual([]);
  });

  it("handles undefined events", () => {
    const result = consumeContractEvents(undefined);
    expect(result.totalRetrieved).toBe(0);
    expect(result.parsedEvents).toEqual([]);
  });

  it("separates unparseable events", () => {
    const events: ContractEventRaw[] = [
      makeRawEvent("CAAAA...", ["StreamDeposit"], { amount: 100n, stream_id: 1n }),
      makeRawEvent("CAAAA...", ["UnknownEvent"], { foo: "bar" }),
    ];

    const result = consumeContractEvents(events);
    expect(result.parsedEvents.length).toBe(1);
    expect(result.unparsedEvents.length).toBe(1);
    expect(result.unparsedEvents[0].topic[0]).toBe("UnknownEvent");
  });
});

describe("filterEventsByType", () => {
  const events = [
    { type: "StreamDeposit", contractId: "C1", topic: ["StreamDeposit"], payload: { amount: 100n, stream_id: 1n } } as any,
    { type: "StreamPaused", contractId: "C1", topic: ["StreamPaused"], payload: { paused_at: 5n, stream_id: 1n } } as any,
    { type: "StreamDeposit", contractId: "C2", topic: ["StreamDeposit"], payload: { amount: 200n, stream_id: 2n } } as any,
  ];

  it("filters by event type", () => {
    const deposits = filterEventsByType(events, "StreamDeposit");
    expect(deposits.length).toBe(2);
    expect(deposits.every((e) => e.type === "StreamDeposit")).toBe(true);
  });

  it("returns empty array when no matches", () => {
    const paused = filterEventsByType(events, "StreamPaused");
    expect(paused.length).toBe(1);
    const none = filterEventsByType(events, "FeeCollected");
    expect(none.length).toBe(0);
  });
});

describe("groupEventsByContract", () => {
  const events = [
    { type: "StreamDeposit", contractId: "C1", topic: ["StreamDeposit"], payload: { amount: 100n, stream_id: 1n } } as any,
    { type: "StreamPaused", contractId: "C1", topic: ["StreamPaused"], payload: { paused_at: 5n, stream_id: 1n } } as any,
    { type: "StreamDeposit", contractId: "C2", topic: ["StreamDeposit"], payload: { amount: 200n, stream_id: 2n } } as any,
  ];

  it("groups events by contract ID", () => {
    const grouped = groupEventsByContract(events);
    expect(grouped.size).toBe(2);
    expect(grouped.get("C1")?.length).toBe(2);
    expect(grouped.get("C2")?.length).toBe(1);
  });
});

describe("getStreamDeposits", () => {
  const events = [
    { type: "StreamDeposit", contractId: "C1", topic: ["StreamDeposit"], payload: { amount: 100n, stream_id: 1n } } as any,
    { type: "StreamPaused", contractId: "C1", topic: ["StreamPaused"], payload: { paused_at: 5n, stream_id: 1n } } as any,
    { type: "StreamDeposit", contractId: "C2", topic: ["StreamDeposit"], payload: { amount: 200n, stream_id: 2n } } as any,
  ];

  it("returns only StreamDeposit events", () => {
    const deposits = getStreamDeposits(events);
    expect(deposits.length).toBe(2);
    expect(deposits.every((e) => e.type === "StreamDeposit")).toBe(true);
  });
});

describe("getStreamPauses", () => {
  const events = [
    { type: "StreamDeposit", contractId: "C1", topic: ["StreamDeposit"], payload: { amount: 100n, stream_id: 1n } } as any,
    { type: "StreamPaused", contractId: "C1", topic: ["StreamPaused"], payload: { paused_at: 5n, stream_id: 1n } } as any,
    { type: "StreamResumed", contractId: "C1", topic: ["StreamResumed"], payload: { resumed_at: 10n, stream_id: 1n } } as any,
    { type: "StreamDeposit", contractId: "C2", topic: ["StreamDeposit"], payload: { amount: 200n, stream_id: 2n } } as any,
  ];

  it("returns StreamPaused and StreamResumed events", () => {
    const pauses = getStreamPauses(events);
    expect(pauses.length).toBe(2);
    expect(pauses.every((e) => e.type === "StreamPaused" || e.type === "StreamResumed")).toBe(true);
  });
});