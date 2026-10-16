# Mobile offline mode & services

Related issues:
- [Fundable-Protocol/stellar_client_os#893](https://github.com/Fundable-Protocol/stellar_client_os/issues/893) — Offline browsing & wishlist sync
- [Amiricloud1/stellar_client_os#90](https://github.com/Amiricloud1/stellar_client_os/issues/90) — Push token rotation & preferences reconciliation
- [Amiricloud1/stellar_client_os#91](https://github.com/Amiricloud1/stellar_client_os/issues/91) — Deep links to cached campaign details
- [Amiricloud1/stellar_client_os#94](https://github.com/Amiricloud1/stellar_client_os/issues/94) — Bounded cache size & freshness presentation

Sponsors can browse campaigns, open deep links, and manage a wishlist even with poor or zero connectivity. When offline, deep links resolve to cached campaign details, stale payloads surface friendly freshness labels, and wishlist mutations queue for deterministic synchronization upon reconnect. Device push notification tokens and preferences are managed locally and reconciled with remote delivery systems.

## Architecture & Modules

All offline and device-management logic is **pure TypeScript** under `src/offline/`, running and tested independently of React Native, Expo, or native device runtimes.

| Module                  | Primary Responsibility                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `storage.ts`            | `KeyValueStorage` abstraction, in-memory implementation, and JSON serialization helpers.    |
| `types.ts`              | Local cache schemas for `CampaignSummary` and `CampaignDetail`.                             |
| `campaignCache.ts`      | Bounded LRU cache, wishlist protection, data freshness metadata, and `CampaignRepository`.  |
| `wishlist.ts`           | Offline-first wishlist (`add` / `remove` / `list`), persisted across app restarts.          |
| `sync.ts`               | Durable queue with latest-op-wins deduplication, sync engine, and reconnect monitor.        |
| `deepLinks.ts`          | Deep-link URL parsing, validation, cold-start offline resolution, and refresh flow.         |
| `pushNotifications.ts`  | Push token lifecycle, per-device category preferences, and remote reconciliation verdicts.|
| `index.ts`              | Service composition (`getOfflineServices`), default wiring, and barrel exports.             |

---

## 1. Bounded Cache & Data Freshness (Issue #94)

### LRU Eviction & Wishlist Protection
To prevent unbounded storage growth on mobile devices:
- `CampaignCache` tracks detail entries in a persisted LRU index (`PersistedDetailIndex`).
- Maximum detail capacity defaults to `maxDetailEntries = 50` (configurable).
- When new detail entries exceed capacity, the least-recently-accessed entries are evicted first.
- **Wishlist protection**: Campaigns saved to the user's wishlist (`protectedIds`) are exempted from eviction regardless of age or access order.

### Stale-State Presentation & Metadata
- Every cached payload records `cachedAt: number` timestamp.
- Read operations via `CampaignRepository` return a `ReadResult<T>` with:
  - `data: T`: The campaign summary or detail payload.
  - `fromCache: boolean`: True when served from local cache.
  - `cachedAt: number | null`: Local cache timestamp.
  - `stale: boolean`: True when served from cache and the age exceeds `staleAfterMs` (default 15 minutes).
- `formatFreshness(ageMs)` computes user-friendly relative age indicators (e.g., `"updated just now"`, `"updated 5m ago"`, `"updated 2h ago"`, `"updated 3d ago"`).

### Migration from Unbounded Cache
When upgrading an existing install:
- Pre-existing cached items lack an LRU index.
- On storage engines providing `getAllKeys()`, existing `campaigns.detail.*` keys are automatically indexed on first load with `lastAccessedAt = cachedAt`.
- On engines without key enumeration, legacy entries remain readable and join eviction as they are accessed or updated.

---

## 2. Deep Links to Cached Campaigns (Issue #91)

### Route Parsing & Validation
`parseCampaignDeepLink(url, options)` parses deep links into campaign targets without side effects:
- Supported schemes & formats:
  - HTTPS / HTTP: `https://app.fundable.com/campaigns/<id>` (also accepts `www.fundable.com` and `fundable.com`)
  - Custom App Scheme: `fundable://campaigns/<id>`
- Query parameters (e.g. `?utm_source=push`) and URL-encoded identifiers (e.g. `%2D`) are supported.
- Malformed inputs, wrong paths, missing IDs, or unsupported hosts return typed errors (`DeepLinkError`) rather than throwing:
  `"not_a_url"` | `"unsupported_scheme"` | `"unsupported_host"` | `"not_a_campaign_route"` | `"missing_campaign_id"` | `"invalid_campaign_id"`

### Resolution Flow & Offline Fallback
`resolveCampaignDeepLink(url, repository, fetchDetail, options)`:
1. **Online (Warm / Cold)**: Attempts network fetch; on success, updates local cache and returns `{ status: "ok", fromCache: false, stale: false, data }`.
2. **Offline (Cached Campaign)**: If network fetch fails, resolves from `CampaignCache` with `{ status: "ok", fromCache: true, stale, cachedAt, data }`.
3. **Offline (Uncached Campaign)**: If neither network nor cache has the campaign, gracefully resolves to `{ status: "unavailable", campaignId, staleLabel }` so the UI can present an actionable offline placeholder and retry when connectivity is restored.
4. **Malformed Link**: Returns `{ status: "malformed", error }` allowing navigation to fall back to the root campaign directory.

---

## 3. Push Token Rotation & Preferences (Issue #90)

### Token Lifecycle & Device Identity
`PushTokenManager` persists and coordinates push notification credentials:
- Generates a stable per-install `deviceId` that survives token rotations but regenerates on a clean reinstall.
- Records current `token` and preserves `previousToken` across rotations until the backend confirms receipt.
- Invalidation: Tracks permission changes (`granted`, `denied`, `undetermined`); token is invalidated if permission is denied or revoked by the OS.

### Per-Device Preferences
Sponsors can toggle individual notification categories per device:
- `campaignUpdates` (default: true)
- `milestones` (default: true)
- `sponsorActivity` (default: true)
- `productNews` (default: false)

### Reconciliation Protocol
The `reconcile(remote)` method synchronizes local state with `PushRemote` transport:
- Handles token rotation: registers new token while instructing backend to retire `previousToken`.
- Handles server verdicts:
  - `keep`: Local token matches server records; no action.
  - `revoke`: Server retired or rejected the token; local token is cleared and ready for new registration.
  - `supersede`: Server has a newer token for this device ID; local store adopts the updated token.
  - `reregister`: Reinstall detected; device identity is reset to generate a fresh registration.

---

## 4. Offline Wishlist & Sync Queue

`WishlistSyncEngine` and `WishlistSyncQueue` provide durable offline mutations:
- Adding or removing campaigns locally updates the offline wishlist immediately.
- Enqueued operations use a deterministic latest-operation-wins merge, preventing duplicate requests during flush.
- `bindSyncOnReconnect` automatically flushes pending operations when transitioning from offline to online.

---

## Wiring into the Mobile Application

### Storage Configuration
Register your preferred storage backend (e.g. `@react-native-async-storage/async-storage`) during app initialization:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { configureOfflineStorage } from "./src/offline";

configureOfflineStorage(AsyncStorage);
```

### Accessing Services
```ts
import { getOfflineServices } from "./src/offline";

const { repository, cache, wishlist, queue } = getOfflineServices();
```

---

## Testing & Verification

Run the test suite and type checking:

```bash
# Workspace root commands
pnpm test:mobile
pnpm typecheck:mobile

# Or directly in apps/mobile
npm run test --prefix apps/mobile
npm run typecheck --prefix apps/mobile
```

Automated test suites:
- `__tests__/campaignCache.test.ts` — LRU eviction, capacity cap, wishlist protection, stale detection, freshness formatting.
- `__tests__/deepLinks.test.ts` — URL scheme parsing, malformed link handling, cold-start offline fallback, uncached state.
- `__tests__/pushNotifications.test.ts` — Token rotation, revocation, per-device preferences, server reconciliation verdicts.
- `__tests__/wishlist.test.ts` — Wishlist persistence, idempotency across app restarts.
- `__tests__/sync.test.ts` — Sync queue deduplication, network reconnect flushing.
- `__tests__/offlineFlow.test.ts` — End-to-end integration: browse offline -> modify wishlist -> sync upon reconnection.
