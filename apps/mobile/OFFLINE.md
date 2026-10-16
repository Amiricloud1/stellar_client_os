# Mobile offline mode

Issue: [Fundable-Protocol/stellar_client_os#893](https://github.com/Fundable-Protocol/stellar_client_os/issues/893)

Sponsors can browse campaigns and manage a wishlist without a connection; queued
wishlist changes are flushed when connectivity is restored.

## What lives here

All offline logic is **pure TypeScript** under `src/offline/`, so it runs and is
tested off-device. It never imports React Native, Expo or a native storage
module.

| Module            | Responsibility                                                        |
| ----------------- | --------------------------------------------------------------------- |
| `storage.ts`      | `KeyValueStorage` contract, in-memory implementation, JSON helpers.   |
| `types.ts`        | `CampaignSummary` / `CampaignDetail` shapes cached locally.          |
| `campaignCache.ts`| Persisted campaign list/detail cache + read-through `CampaignRepository`. |
| `wishlist.ts`     | Offline-first wishlist (`add` / `remove` / `list`), persisted.        |
| `sync.ts`         | Durable wishlist sync queue, sync engine, connectivity monitor.      |
| `telemetry.ts`    | Privacy-safe sync telemetry (queue depth, latency, retries, failure classes). |
| `index.ts`        | `getOfflineServices()` composition + barrel exports.                 |

### Read-through cache

`CampaignRepository.loadList` / `loadDetail` are network-first: a successful
fetch refreshes the cache, and a failed fetch transparently falls back to the
last cached payload (`fromCache: true`). If nothing is cached the caller can
supply a `fallback` (e.g. `[]` for the browse list) or the original error is
re-thrown.

### Offline wishlist + sync

`WishlistSyncEngine.add/remove` mutate the local wishlist and enqueue an
operation durably. `WishlistSyncQueue` applies a deterministic merge — for each
campaign only the **latest** operation survives — so flushing can never emit
duplicates. `bindSyncOnReconnect` subscribes to a `ConnectivityMonitor` and
flushes the queue on an offline → online transition only; failed operations stay
queued for the next attempt.

### Sync telemetry (privacy-safe, opt-in)

Issue: [Amiricloud1/stellar_client_os#93](https://github.com/Amiricloud1/stellar_client_os/issues/93)

`telemetry.ts` emits aggregate sync health signals so operators can see how the
offline queue behaves in the field **without collecting any user content**:

| Signal            | Event     | Fields                                                     |
| ----------------- | --------- | ---------------------------------------------------------- |
| Queue health      | `flush`   | `queueDepth`, `synced`, `failed`, `latencyMs`, `retries`   |
| Failure taxonomy  | `failure` | `failureClass` (`network` / `timeout` / `auth` / `conflict` / `server` / `unknown`), `attempt` |

Privacy guarantees:

- **No drafts, no wallet data.** The sink allowlists only the numeric counters
  and closed-enum strings above. Campaign ids, wishlist contents, wallet
  addresses and raw error messages are dropped by
  `sanitizeSyncTelemetryEvent` even if a caller pollutes the payload.
- **No raw error messages.** `classifySyncError` reads only structural hints
  (`name`, `code`, `status`/`statusCode`); messages may embed user data and are
  never forwarded.
- **Opt-out / opt-in.** Telemetry is opt-in: the engine records nothing unless
  a sink is injected. Pass `enabled: false` to `createPrivacySafeSyncTelemetry`
  to keep the wiring but drop every event.

```ts
import { createPrivacySafeSyncTelemetry, WishlistSyncEngine } from "./src/offline";

const telemetry = createPrivacySafeSyncTelemetry({
  enabled: !userOptedOut, // respect a user "disable analytics" setting
  onEvent: (event, metrics) => analytics.track(`offline.sync.${event}`, metrics),
});

const engine = new WishlistSyncEngine({ wishlist, queue, remote, telemetry });
```

Telemetry never breaks a flush: a throwing sink is caught and ignored.

**Compatibility / migration:** none required. The queue's persisted
`WishlistOperation` gains an *additive, optional* `attempts` counter (used for
retry telemetry). Queues persisted by older builds simply read it as `0`; no
storage migration or version bump is needed, and a sink-less engine behaves
exactly as before.

## Lifecycle tests

Issue: [Amiricloud1/stellar_client_os#95](https://github.com/Amiricloud1/stellar_client_os/issues/95)

`__tests__/lifecycle.test.ts` exercises the full offline lifecycle with
deterministic fixtures (fixed clocks, scripted remotes — no live network or
funds):

1. **Cache** — online browse populates the persisted list/detail cache; offline
   reads are served from it (`fromCache: true`).
2. **Queue** — offline wishlist edits are queued durably and collapse via the
   deterministic merge.
3. **Restart** — the services are rebuilt over the same `KeyValueStorage`
   (simulating a process restart with a persisted backend); cache, queue and
   wishlist all survive.
4. **Conflict** — a scripted remote rejects one op with a `409`; the op stays
   queued with `attempts` incremented, is classified as `conflict` in telemetry,
   and the local latest state wins on the successful retry.
5. **Reconnect** — a manual connectivity source flips offline → online; the
   queue drains in order, exactly once per operation, and redundant online
   signals are ignored.

### Platform coverage & known gaps

The suite runs the **pure TypeScript** offline modules in Node (see
`vitest.config.ts`). Deterministic fixtures stand in for the platform:

| Surface                | CI coverage                                   | Gap (not exercised in CI)                                  |
| ---------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `KeyValueStorage`      | Injected in-memory store                      | Real `AsyncStorage`/MMKV: native serialization, disk-full, corrupted installs |
| Connectivity           | Manual `ConnectivitySource`                   | `@react-native-community/netinfo` event semantics, flapping radios |
| Reconnect flush        | Explicit offline → online transitions         | OS background/resume, WebSocket lifecycle in `CampaignDetailScreen` |
| Sync transport         | Scripted `WishlistRemote` fakes               | Real API auth, rate limits, multi-device convergence       |

Bridging these gaps needs the React Native toolchain (see the note at the end
of this document); the pure-layer contract they must satisfy is pinned by the
deterministic suite above.

## Wiring it into an app

### 1. Storage

No storage library existed in this package before this change, so the layer is
written against an injectable `KeyValueStorage` interface instead of hard-coding
a dependency. Register your backend once at startup:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { configureOfflineStorage } from "./src/offline";

configureOfflineStorage(AsyncStorage);
```

`KeyValueStorage` is a subset of the AsyncStorage API, so any compatible store
works. If nothing is configured the layer falls back to an in-process memory
store (session-scoped).

### 2. Connectivity

`createConnectivityMonitor(source)` wraps any `ConnectivitySource`. The
`CampaignDetailScreen` drives it from the existing WebSocket lifecycle
(`onopen` → online, `onclose`/`onerror` → offline). To use
`@react-native-community/netinfo` instead, pass a source that subscribes to
`NetInfo.addEventListener` and calls the listener with `state.isConnected`.

## Tests

```
pnpm --filter @fundable/mobile test        # vitest run
pnpm --filter @fundable/mobile typecheck   # tsc --noEmit
```

Coverage:

- `__tests__/campaignCache.test.ts` — cache write → offline read; empty-cache
  fallback and error re-throw; namespace isolation.
- `__tests__/wishlist.test.ts` — offline add/remove persistence across restarts;
  idempotency.
- `__tests__/sync.test.ts` — queue collapse; flush without duplicates; failed
  ops stay queued; flush happens only on reconnect.
- `__tests__/telemetry.test.ts` — failure classification; payload field
  exclusions (no drafts / wallet data / raw messages); opt-out; deterministic
  latency and retry counters; boundary cases (empty queue, clock regression,
  throwing sink).
- `__tests__/lifecycle.test.ts` — end-to-end offline browse → wishlist edits →
  restart → conflict → reconnect flush; corrupted-queue recovery; empty-queue
  reconnect.
- `__tests__/offlineFlow.test.ts` — end-to-end offline browse → wishlist edits →
  sync-on-reconnect; empty-cache offline path.

CI runs this suite (plus `typecheck`) via `.github/workflows/mobile-ci.yml` on
every change touching `apps/mobile/`.

> Note: the pre-existing `src/screens/CampaignDetailScreen.tsx` imports
> `react-native` / `expo-notifications`, which are not part of this repo's
> dependency manifest. The mobile `typecheck`/`test` scripts therefore scope to
> the pure offline modules. Add the React Native toolchain (or a Jest preset) if
> you want component-level tests too.
