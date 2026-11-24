# Campaign verification transparency

## Immutable audit trail

`GET /api/campaigns/:id/verification` returns the append-only verification log. `POST` accepts `submitted_for_review`, `verifier_comment`, `photo_uploaded`, `approved`, and `rejected` events. Each entry contains the actor, timestamp, optional comment/evidence reference, a SHA-256 `entryHash`, `previousHash`, and a `blockchainTxHash` anchor. Production indexers should provide the Soroban transaction hash and ledger sequence; development-only entries use a `pending:` anchor.

## Evidence quarantine and scanning

All evidence uploads generated via `POST /api/presign-upload` land inside the private `quarantine/evidence/{campaignId}/{milestoneId}/{uuid}.{ext}` namespace and are registered in `quarantined` state (`quarantineId`, `scanStatus: "quarantined"`, `recoveryAction: "await_scan"`).

Before evidence can be published to a campaign, it must pass security scanning via `POST /api/campaigns/:id/verification/evidence/quarantine` (or `EvidenceQuarantineService.scanEvidence`):

| State | Meaning | Publishable | Recovery action |
| ----- | ------- | ----------- | --------------- |
| `quarantined` | Uploaded to private quarantine storage; awaiting scan | No (`409`) | `await_scan` |
| `scanning` | Security scan currently in progress | No (`409`) | `await_scan` |
| `clean` | Magic bytes match declared MIME type; no executable, malware, or active-content findings | Yes (`201`) | `ready_to_publish` |
| `infected` | Threat, polyglot, or magic-byte mismatch detected; permanently blocked | No (`422`) | `reupload_clean_file` |
| `scan_failed` | Transient scanner failure; fails closed with bounded retries (default max 3) | No (`503`) | `retry_scan` (or `reupload_clean_file` once exhausted) |
| `published` | Promoted to `evidence/{campaignId}/{milestoneId}/{uuid}.{ext}` and linked to campaign | Idempotent | `none` |

Inspect current status and findings with `GET /api/campaigns/:id/verification/evidence/quarantine?quarantineId=<id>`. Direct publication of raw `quarantine/evidence/...` URLs without a verified `quarantineId` is rejected with `409 QUARANTINE_NOT_CLEAN`.

## Evidence publication and location precision minimization

After a quarantined upload is scanned `clean`, publish its metadata with `POST /api/campaigns/:id/verification/evidence`:

```json
{
  "id": "evidence-42",
  "type": "photo",
  "url": "https://cdn.example/evidence/camp-1/ms-1/evidence-42.jpg",
  "quarantineId": "qev-...",
  "capturedAt": 1780000000000,
  "latitude": -1.2921456,
  "longitude": 36.8219462,
  "locationPrecision": "district",
  "verifierId": "GVERIFIER",
  "caption": "Plot 7 after planting"
}
```

To protect planter privacy, community safety, and sensitive habitats, coordinates are minimized at the ingestion boundary (`apps/web/src/lib/location-precision.ts`):

- **`district` (default)**: Quantizes coordinates to 2 decimal places (`~1.11 km` grid cell), e.g., `-1.29, 36.82`.
- **`region`**: Quantizes coordinates to 1 decimal place (`~11.1 km` grid cell).
- **`redacted`**: Strips `latitude` and `longitude` completely while recording `locationPrecision: "redacted"`.
- **`exact`**: Restricted to authorized admins (`Authorization: Bearer <ADMIN_API_KEY>`) or verifiers; unprivileged callers receive `403 EXACT_PRECISION_UNAUTHORIZED` with `recoveryAction: "use_minimized_precision"`.

Incomplete coordinate pairs (only `latitude` or only `longitude`) are rejected with `400 INCOMPLETE_COORDINATES`. Legacy callers that omit `quarantineId` (for non-quarantine URLs) and `locationPrecision` remain supported and automatically receive default `district` coordinate minimization.

The campaign detail page renders published evidence with timestamp, precision-aware coordinates (or a redaction notice), and verifier identity.

## Export

`GET /api/campaigns/:id/export?format=csv&report=full` downloads sponsor, impact, GPS, CO2, and status timeline data. Use `format=json` for a structured export containing sponsors, campaign impact, timeline, verification audit trail, and evidence.

## Webhooks

Subscribe to `tree_verified`, `batch_verified`, `campaign_milestone_reached`, and `campaign_completed` in addition to existing event types. Payloads use the existing signed, retrying, idempotent delivery mechanism. Include a stable `eventId` (or `verificationId`) in every event so consumers can safely retry.
