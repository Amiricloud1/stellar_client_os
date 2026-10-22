# Webhook Event Schemas & Delivery Guarantees

This document publishes the **versioned webhook event payload schemas** and the **delivery guarantees** for the Fundable Webhook Delivery System. It is the authoritative reference for subscribers (operator-facing) and for the SDK/webapp producers that emit events.

Body: see `docs/webhooks.md` for the subscription API, signature verification example, retry/DLQ policy, and event-type table.

## Versioning

Event payloads are versioned with a major version in the `eventVersion` field (e.g. `1`). The version is stable for the lifetime of a payload shape; breaking changes bump the major version and produce a new event type namespace. Subscribers opt into a version when they subscribe. The current published version is `1`.

| Version | Lifecycle |
|---------|-----------|
| `1` | Active. Published 2026-07-14; current default. |

## Delivery Guarantees (Summary)

| Guarantee | Behavior |
|-----------|----------|
| Ordering | Events for a subscription are delivered in the order their source `eventId` was emitted. A subscription sees a strict total order per `eventId` namespace. |
| At-least-once | Every durable source event is delivered at least once. Idempotency keys let subscribers treat duplicate deliveries as a single logical event. |
| Retries | 5 attempts with exponential backoff; after the 5th failure the attempt is persisted to the dead-letter queue (see `docs/webhooks.md` §Retries). |
| Signatures | All payloads are signed with `X-Webhook-Timestamp`, `X-Webhook-Signature` (HMAC-SHA256), `X-Webhook-Event`, and `X-Webhook-Delivery-Id` headers. |
| Replay | A replayed dispatch that is idempotent is delivered once per `eventId`; non-idempotent events are not re-delivered and fail (they are retried). |
| Deprecation | Deprecated versions/event types are published with a `Deprecation` header and retained for 90 days before removal; see `Deprecation` section. |

## Payload Schema (Version 1)

```json
{
  "eventVersion": 1,
  "eventId": "<stable identity string>",
  "eventType": "stream.status_updated",
  "subscriptionId": "sub_12345abcd",
  "deliveredAt": "2026-07-29T13:00:00.000Z",
  "payload": { "/* event-type-specific fields */" }
}
```

- `eventId` is the stable identity used for ordering and replay (e.g. `"{campaignId}:{percentage}"`, `{verificationId}`, `{batchId}`). Do not use `X-Webhook-Delivery-Id` as an idempotency key.
- `payload` carries the event-type-specific fields. Example payloads for each `eventType` are listed below and are validated against the fixture suite in `packages/sdk/src/__tests__/docs-validation.test.ts` (and the webhook fixture directory) on every CI run.

## Event Type Schemas

### `stream.status_updated`

```json
{
  "eventVersion": 1,
  "eventId": "stream:<streamId>",
  "eventType": "stream.status_updated",
  "subscriptionId": "sub_12345abcd",
  "deliveredAt": "2026-07-29T13:00:00.000Z",
  "payload": {
    "streamId": "<stream identifier>",
    "status": "Active | Paused | Canceled | Completed | Disputed",
    "updatedAt": "2026-07-29T13:00:00.000Z"
  }
}
```

### `milestone.funds_released`

```json
{
  "eventVersion": 1,
  "eventId": "milestone:<campaignId>:<percentage>",
  "eventType": "milestone.funds_released",
  "subscriptionId": "sub_12345abcd",
  "deliveredAt": "2026-07-29T13:00:00.000Z",
  "payload": {
    "campaignId": "<campaign identifier>",
    "percentage": 25,
    "releasedAmount": "100.00"
  }
}
```

### `campaign.milestone_reached`

```json
{
  "eventVersion": 1,
  "eventId": "campaign:<campaignId>:impact:<milestone>",
  "eventType": "campaign.milestone_reached",
  "subscriptionId": "sub_12345abcd",
  "deliveredAt": "2026-07-29T13:00:00.000Z",
  "payload": {
    "campaignId": "<campaign identifier>",
    "milestone": "1000_trees | 5000_trees | 10_tons_co2",
    "treeCount": 1000,
    "co2Sequestration": "12.5"
  }
}
```

### `tree_verified`

```json
{
  "eventVersion": 1,
  "eventId": "<verificationId>",
  "eventType": "tree_verified",
  "subscriptionId": "sub_12345abcd",
  "deliveredAt": "2026-07-29T13:00:00.000Z",
  "payload": {
    "campaignId": "<campaign identifier>",
    "treeId": "<tree identifier>",
    "verifierId": "<verifier identifier>",
    "verifiedAt": "2026-07-29T13:00:00.000Z",
    "latitude": 12.345678,
    "longitude": 98.765432
  }
}
```

### `batch_verified`

```json
{
  "eventVersion": 1,
  "eventId": "<batchId>",
  "eventType": "batch_verified",
  "subscriptionId": "sub_12345abcd",
  "deliveredAt": "2026-07-29T13:00:00.000Z",
  "payload": {
    "campaignId": "<campaign identifier>",
    "treeIds": ["<treeId_1>", "<treeId_2>"],
    "treeCount": 10,
    "verifiedAt": "2026-07-29T13:00:00.000Z"
  }
}
```

### `campaign_completed`

```json
{
  "eventVersion": 1,
  "eventId": "<completionId>",
  "eventType": "campaign_completed",
  "subscriptionId": "sub_12345abcd",
  "deliveredAt": "2026-07-29T13:00:00.000Z",
  "payload": {
    "campaignId": "<campaign identifier>",
    "completedAt": "2026-07-29T13:00:00.000Z",
    "treeCount": 10000,
    "co2Sequestration": "120.0"
  }
}
```

## Validation Against Fixtures

All published payload examples are stored as machine-readable fixtures under `packages/sdk/src/__tests__/webhook-fixtures/` and are validated against the JSON Schema in `packages/sdk/src/__tests__/webhook-schemas.ts` on every CI run. The validation checks:

1. Example payload parses as a JSON object.
2. `eventVersion` is `1` for every example.
3. `eventId` matches the expected stable-identity pattern for the event type (string, non-empty).
4. `eventType` is one of the published event types.
5. Event-type-specific required fields are present and typed per the examples above.
6. No example payload is empty or contains `undefined`.

When you add a new event type or change a payload shape:

1. Add the example object to `packages/sdk/src/__tests__/webhook-fixtures/`.
2. Add the JSON Schema definition to `packages/sdk/src/__tests__/webhook-schemas.ts`.
3. Add a `describe`/it case in `packages/sdk/src/__tests__/docs-validation.test.ts` covering success, failure (invalid type/field), and boundary (empty payload, missing field) cases.
4. Re-run `pnpm --filter @fundable/sdk test` locally.

## Deprecation

- A deprecated version or event type is announced in the `Deprecation` header with the removal date.
- Subscribers that continue to receive the deprecated shape are not broken, but `Deprecation` is set immediately.
- Removal is scheduled at least 90 days after the deprecation announcement.
- Deprecated event types/versions are listed in the table below; add new deprecated entries there before they surface to producers.

| Deprecated version/event | Announced | Removal date | Replacement |
|--------------------------|-----------|--------------|-------------|

## Compatibility & Migration Implications

- A payload shape change is a breaking change and bumps `eventVersion`. Existing subscribers must be migrated to the new version before the old version is retired.
- `eventId` stability is contractual: changing `eventId` generation breaks replay/ordering and must ship as a new major version.
- Delivery semantics (ordering, retries, signatures) are unchanged by version bumps; only the payload shape and event-type namespace change.
