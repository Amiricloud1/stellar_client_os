# Webhook Delivery System

The Fundable Webhook Delivery System enables real-time notification of events on the platform (e.g., when a stream status is updated, milestone funds are released, or a campaign reaches a funding milestone) directly to external HTTP endpoints.

Campaign integrations can subscribe to `tree_verified`, `batch_verified`, `campaign_milestone_reached`, and `campaign_completed`. Individual verification payloads use `verificationId` as their stable event identity; batch payloads use `batchId`, and completion payloads use `completionId`. A `batch_verified` event is emitted only for batches containing at least 10 trees.

## 🚀 Subscription Management API

### 1. Register a Subscription
* **Endpoint:** `POST /api/webhooks/subscriptions`
* **Content-Type:** `application/json`
* **Request Body:**
```json
{
  "url": "https://your-service.com/webhook",
  "events": ["tree_verified", "batch_verified", "campaign_milestone_reached", "campaign_completed"],
  "secret": "your_custom_secret_key" // Optional: auto-generated if omitted (min 8 chars)
}
```
* **Response:**
```json
{
  "id": "sub_12345abcd",
  "url": "https://your-service.com/webhook",
  "events": ["stream.status_updated", "milestone.funds_released", "campaign.milestone_reached"],
  "secret": "generated_or_provided_secret_key",
  "createdAt": "2026-07-29T13:00:00.000Z"
}
```

### 2. List Subscriptions
* **Endpoint:** `GET /api/webhooks/subscriptions`
* **Response:**
```json
[
  {
    "id": "sub_12345abcd",
    "url": "https://your-service.com/webhook",
    "events": ["stream.status_updated", "milestone.funds_released", "campaign.milestone_reached"],
    "secret": "generated_or_provided_secret_key",
    "createdAt": "2026-07-29T13:00:00.000Z"
  }
]
```

### 3. Delete a Subscription
* **Endpoint:** `DELETE /api/webhooks/subscriptions/[id]`
* **Response:**
```json
{
  "success": true,
  "message": "Subscription deleted successfully"
}
```

---

## ♻️ Idempotent Event Delivery

When the same source event can be observed through more than one backend path, include a stable identity in the event payload so it can be delivered only once to each subscriber. The webhook service recognizes `idempotencyKey`, `eventId`, `notificationId`, `verificationId`, `nullifier`, `txHash`, and their snake-case equivalents. For tree-verification events, the verification event ID or nullifier is the appropriate identity; the generated `X-Webhook-Delivery-Id` must not be used because it changes on every attempt.

Successful identities are persisted in `apps/web/data/webhook_delivered_events.json`, and concurrent dispatches are reserved before delivery. De-duplication is scoped to the subscription, so the same event is still delivered once to every distinct subscriber. Events without a stable identity retain the existing at-least-once behavior, and failed deliveries are not marked as complete so a later dispatch can retry them.

---

## 🔒 Signature Verification

Every webhook payload delivered includes the following headers to enable authenticity verification and prevent replay attacks:

* `X-Webhook-Timestamp`: Unix epoch timestamp (seconds) of the dispatch.
* `X-Webhook-Signature`: Versioned signature header, `v1=<hmac_sha256_hex>` (see below).
* `X-Webhook-Event`: The type of event (e.g. `stream.status_updated`).
* `X-Webhook-Delivery-Id`: Stable delivery ID for the event (see below).

### Signature Header Format (v1)

The signature header is versioned so the signing scheme can evolve without
breaking existing consumers:

```
X-Webhook-Signature: v1=<hex-encoded HMAC-SHA256>
```

Consumers must parse the header, select the `v1` scheme, and ignore unknown
schemes (e.g. a future `v2=`) rather than rejecting the request outright. If
multiple space-separated signatures are present, accept the request when any
one of them verifies.

### Canonical Signing String

The signed string is exactly:

```
<X-Webhook-Timestamp>.<raw_request_body>
```

where `<raw_request_body>` is the exact bytes received on the wire (not a
re-serialized object). Sign with the subscription `secret` using HMAC-SHA256
and hex-encode the digest. Compare signatures in constant time.

### Verifying Signatures (Node.js Example)

```javascript
import { createHmac, timingSafeEqual } from 'crypto';

const REPLAY_WINDOW_SECONDS = 300; // 5 minutes

function verifyWebhook(req, secrets) {
  const timestamp = req.headers['x-webhook-timestamp'];
  const header = req.headers['x-webhook-signature'];
  const rawBody = req.rawBody; // exact raw body string/bytes as received

  if (!timestamp || !header || !rawBody) return false;

  // Replay window: reject stale or far-future timestamps.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > REPLAY_WINDOW_SECONDS) return false;

  const provided = header
    .split(' ')
    .filter((part) => part.startsWith('v1='))
    .map((part) => part.slice(3));

  const payload = `${timestamp}.${rawBody}`;
  // `secrets` may contain the primary and (during rotation) secondary secret.
  return secrets.some((secret) => {
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    const a = Buffer.from(expected, 'hex');
    return provided.some((sig) => {
      const b = Buffer.from(sig, 'hex');
      return a.length === b.length && timingSafeEqual(a, b);
    });
  });
}
```

### Delivery ID Semantics

`X-Webhook-Delivery-Id` identifies the *event*, not the individual HTTP
attempt. It is derived from the event's stable identity (e.g. `verificationId`,
`batchId`, `completionId`, or `eventId`) and is therefore identical across
retries. Consumers should use it (or the payload's stable identity field) as an
idempotency key and process each delivery ID at most once. Do not treat a
repeated delivery ID as a new event.

### Replay Window

Deliveries are timestamped at dispatch. Consumers should reject requests whose
`X-Webhook-Timestamp` is more than **5 minutes** (300 seconds) away from their
own clock, in either direction. Combined with the delivery ID idempotency check,
this bounds the window in which a captured request can be replayed. Keep
consumer clocks synchronized (NTP) to avoid false rejections.

### Key Rotation (Primary / Secondary Secrets)

Each subscription supports a primary secret and an optional secondary secret so
secrets can be rotated without dropping deliveries:

1. **Add the new secret as secondary.** Set `secondarySecret` on the
   subscription (via the subscription update API) while the primary remains
   active. Deliveries are signed with the primary secret; consumers should
   accept either secret during rotation.
2. **Update the consumer.** Deploy the consumer so it verifies against both the
   old and new secrets.
3. **Promote the new secret.** Swap the values so the new secret becomes
   primary and the old secret becomes secondary. New deliveries are now signed
   with the new secret.
4. **Remove the old secret.** Once logs show no deliveries verifying only with
   the old secret, clear `secondarySecret`.

Never remove a secret before consumers accept the replacement, and never reuse
a previously retired secret.

---

## 🔄 Delivery Retries and Dead-Letter Queue (DLQ)

If a subscriber's endpoint fails to acknowledge the webhook payload (returns a non-2xx status, times out, or encounters a network error), the delivery system will automatically retry with a bounded policy:

* **Max Attempts:** 5 total attempts (1 initial + 4 retries).
* **Exponential Backoff:** The delay doubles after each failed attempt:
  * Attempt 1: Immediate
  * Attempt 2: 2s delay
  * Attempt 3: 4s delay
  * Attempt 4: 8s delay
  * Attempt 5: 16s delay
* **Stable Identity Across Retries:** Every attempt reuses the same
  `X-Webhook-Delivery-Id` but carries a fresh `X-Webhook-Timestamp` and
  signature, so consumers can de-duplicate by delivery ID while still
  validating the replay window per attempt.
* **Dead-Letter Queue:** If all 5 attempts fail, the delivery attempt (including the payload, destination URL, status code, timestamps, and error message) is permanently logged to the dead-letter queue (`apps/web/data/webhook_dead_letter.json`).

## 📡 Event Types

| Event | Description | Example payload fields |
| ----- | ----------- | --------------------- |
| `stream.status_updated` | A payment stream changed status | `streamId`, `status` |
| `milestone.funds_released` | Funds were released at a stream/payout milestone | `campaignId`, `percentage` |
| `campaign.milestone_reached` | A campaign crossed a funding milestone (25/50/75/100% of goal) | `eventId` (`"{campaignId}:{percentage}"`), `campaignId`, `campaignName`, `percentage`, `raisedAmount`, `goalAmount` |
| `tree_verified` | An individual tree verification was accepted | `eventId`, `campaignId`, `treeId`, `verifierId`, `verifiedAt`, `latitude`, `longitude` |
| `batch_verified` | A batch of 10 or more trees was verified | `eventId`, `campaignId`, `treeIds`, `treeCount`, `verifiedAt` |
| `campaign_milestone_reached` | A campaign reached 1,000 trees, 5,000 trees, or 10 tonnes of CO2 sequestration | `eventId`, `campaignId`, `milestone`, `treeCount`, `co2Sequestration` |
| `campaign_completed` | All campaign verification requirements completed | `eventId`, `campaignId`, `completedAt`, `treeCount`, `co2Sequestration` |

`campaign.milestone_reached` fires once per milestone crossed by a contribution
(e.g. a contribution that crosses both 50% and 75% emits two events). The
`eventId` is stable per (campaign, milestone), so idempotent delivery never
re-sends a milestone that was already delivered.

`campaign_milestone_reached` fires when a campaign record is saved with a newly
reached impact threshold. Impact totals can be submitted through
`PATCH /api/campaigns/{id}` with `treeCount` (non-negative whole number) and/or
`co2Sequestration` (non-negative decimal string in metric tonnes). Subscribe to
this event (or `*`) through `POST /api/webhooks/subscriptions`. The `milestone`
value is `1000_trees`, `5000_trees`, or `10_tons_co2`; `co2Sequestration` is a
decimal string in metric tonnes (or `null` when unavailable). A single update
can emit multiple events.
Each event ID is `{campaignId}:impact:{milestone}`. Repeated saves and later
decreases and increases do not emit a threshold again for the same campaign.
