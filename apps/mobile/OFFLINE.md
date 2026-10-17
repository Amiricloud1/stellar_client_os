# Mobile offline mode

Issues:
- [#86 Expo/React Native build commands](https://github.com/Amiricloud1/stellar_client_os/issues/86)
- [#87 Encrypt sensitive offline storage](https://github.com/Amiricloud1/stellar_client_os/issues/87)
- [#88 Idempotent offline action queue](https://github.com/Amiricloud1/stellar_client_os/issues/88)
- [#89 Server-authoritative conflict resolution](https://github.com/Amiricloud1/stellar_client_os/issues/89)

Sponsors can browse campaigns and manage a wishlist without a connection; queued
wishlist changes are flushed when connectivity is restored. Sensitive fields
are encrypted at rest, queued actions carry stable IDs for idempotent replay,
and conflicts are resolved using a server-authoritative merge strategy.

---

## What lives here

All offline logic is **pure TypeScript** under `src/offline/`, so it runs and is
tested off-device. It never imports React Native, Expo or a native storage
module directly — those are injected via interfaces.

| Module                  | Responsibility                                                           |
| ----------------------- | ------------------------------------------------------------------------ |
| `storage.ts`            | `KeyValueStorage` contract, in-memory implementation, JSON helpers.      |
| `types.ts`              | `CampaignSummary` / `CampaignDetail` shapes cached locally.             |
| `campaignCache.ts`      | Persisted campaign list/detail cache + read-through `CampaignRepository`. |
| `wishlist.ts`           | Offline-first wishlist (`add` / `remove` / `list`), persisted.           |
| `sync.ts`               | Durable wishlist sync queue, sync engine, connectivity monitor.         |
| `encryptedStorage.ts`   | Cipher interface, XOR test cipher, encrypted read/write helpers, schema migration, `clearSensitiveStorage`, `EncryptedKeyValueStorage`. |
| `actionQueue.ts`        | `IdempotentActionQueue` with stable `operationId`, `flushActionQueue`.   |
| `conflictResolution.ts` | Campaign server-wins merge, wishlist merge, permission-change detection, partial sync recovery. |
| `index.ts`              | `getOfflineServices()` composition + barrel exports.                    |

---

## #86 — Expo / React Native build toolchain

### Runtime requirements

| Tool        | Version  | Purpose                            |
|-------------|----------|------------------------------------|
| Node.js     | ≥ 18     | Build scripts, offline layer tests |
| pnpm        | 9        | Monorepo package manager           |
| Expo CLI    | 52       | `expo start`, `expo run:*`         |
| EAS CLI     | ≥ 12     | Cloud builds, OTA updates          |

### Development builds

```bash
# Start the Metro dev server (or Expo Go):
pnpm --filter @fundable/mobile start

# Run on a connected Android device/emulator:
pnpm --filter @fundable/mobile android

# Run on a connected iOS simulator (macOS only):
pnpm --filter @fundable/mobile ios
```

### Production builds (EAS Build)

Set the `EAS_TOKEN` environment variable (or `EXPO_TOKEN`) then:

```bash
# Android internal preview:
pnpm --filter @fundable/mobile build:android:preview

# iOS internal preview:
pnpm --filter @fundable/mobile build:ios:preview

# Both platforms, production channel:
pnpm --filter @fundable/mobile build:all:prod
```

Build profiles are defined in `eas.json`:

| Profile      | Distribution | Channel    | Description                          |
|--------------|--------------|------------|--------------------------------------|
| `development`| Internal     | —          | Dev client with hot reload           |
| `preview`    | Internal     | `preview`  | QA distribution via EAS              |
| `production` | Store        | `production` | App Store / Google Play release    |

### OTA updates

```bash
pnpm --filter @fundable/mobile update
# Publishes an update to the active channel via EAS Update.
```

### CI

The `.github/workflows/mobile.yml` workflow runs on every push / PR that
touches `apps/mobile/**`. It:

1. Runs the full offline test suite (`vitest run`).
2. Type-checks the offline layer (`tsc --noEmit`).
3. Validates `eas.json` schema and `app.config.ts` structure.

EAS Build steps are guarded by `github.event.pull_request.head.repo.fork != true`
so they only run on same-repo PRs where secrets are available.

---

## #87 — Encrypted sensitive offline storage

### Field classification

| Classification | Examples                             | Storage treatment           |
|----------------|--------------------------------------|-----------------------------|
| **Sensitive**  | wallet address, auth token, seed phrase | Encrypted via `StorageCipher` |
| **Non-sensitive** | campaign list, wishlist IDs, cache TTLs | Stored as plain JSON      |

Sensitive keys live under the `fundable.offline.secure.*` namespace.

### Wiring a cipher in an Expo app

```ts
import * as SecureStore from "expo-secure-store";
import { EncryptedKeyValueStorage, type StorageCipher } from "./src/offline";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Build a cipher backed by expo-secure-store's device-level key.
const cipher: StorageCipher = {
  async encrypt(plaintext) {
    const key = await SecureStore.getItemAsync("storage-key");
    // ... AES-256-GCM encrypt plaintext with key
    return ciphertext;
  },
  async decrypt(ciphertext) {
    const key = await SecureStore.getItemAsync("storage-key");
    // ... decrypt
    return plaintext;
  },
};

const storage = new EncryptedKeyValueStorage(AsyncStorage, cipher);
configureOfflineStorage(storage);
```

### Schema versioning

Every stored blob includes a `schemaVersion` integer. When a new app version
changes the persisted shape, register a migration:

```ts
import { readEncryptedJSON, type MigrationMap } from "./src/offline";

const migrations: MigrationMap = {
  // Upgrade a v1 blob to v2 (increment CURRENT_SCHEMA_VERSION in encryptedStorage.ts).
  1: (data) => ({ ...(data as OldShape), newField: "default" }),
};

const value = await readEncryptedJSON(storage, cipher, key, migrations);
```

### Logout / account-switch cleanup

```ts
import { clearSensitiveStorage } from "./src/offline";

async function onLogout() {
  await clearSensitiveStorage(storage);
  // Non-sensitive campaign cache is untouched.
}
```

### Corruption recovery

If decryption or JSON parsing fails (tampered data, key rotation), the corrupt
entry is automatically deleted and `null` is returned. The caller should treat
`null` as a cache miss and re-fetch from the network.

---

## #88 — Idempotent offline action queue

Every mutation is assigned a **stable `operationId`** (UUID v4) at enqueue time
and persisted before any network call. Replaying the queue after a crash
re-uses the same ID, so the server can detect and discard duplicates.

### Usage

```ts
import { IdempotentActionQueue, flushActionQueue } from "./src/offline";

const actionQueue = new IdempotentActionQueue(storage);

// Enqueue a mutation (returns the action with its stable operationId):
const action = await actionQueue.enqueue("wishlist/add", { campaignId: "c1" });

// On reconnect, flush all pending/failed actions:
await flushActionQueue(actionQueue, async (action) => {
  // Forward action.operationId as an idempotency key to your server:
  await api.wishlist.add(action.payload.campaignId, {
    idempotencyKey: action.operationId,
  });
});
```

### Lifecycle

```
enqueue() → status: "pending"
flushActionQueue() calls markInFlight() → status: "in-flight", attemptCount++
  success → dequeue()              (removed from queue)
  failure → markFailed()           status: "failed"

Next flush picks up "pending" | "failed" entries.
```

A crash between `markInFlight` and `dequeue` leaves the entry as `"in-flight"`.
The next flush ignores `"in-flight"` entries (they won't be retried
automatically). Use `markFailed` on startup to reset any stale `"in-flight"`
entries if your crash-recovery policy requires it.

---

## #89 — Server-authoritative conflict resolution

The server is the single source of truth. Three merge strategies cover the
main conflict surfaces.

### Campaign detail — server-wins

```ts
import { resolveCampaignConflict } from "./src/offline";

const resolution = resolveCampaignConflict(localCampaign, serverCampaign);
if (resolution.localDataDiscarded) {
  console.warn(resolution.description);
}
await cache.saveDetail(resolution.resolved!.id, resolution.resolved!);
```

| Scenario                     | Outcome            |
|------------------------------|--------------------|
| Server differs from local    | `server-wins`      |
| Server returns null (deleted)| `deleted`          |
| No local version             | `server-wins`      |

### Wishlist — merge with pending additions

```ts
import { resolveWishlistConflict } from "./src/offline";

const resolution = resolveWishlistConflict({
  localIds: await wishlist.list(),
  serverIds: serverWishlist,
  // IDs still in the actionQueue that haven't been confirmed yet:
  pendingLocalAdditions: pendingAddIds,
});
await wishlist.replace(resolution.resolved);
```

Server removals always win. Unsynced local additions survive until the server
confirms or the next full sync drops them.

### Partial sync recovery

```ts
import { mergePartialSync } from "./src/offline";

const result = mergePartialSync(batchOutcomes);
await queue.markSynced(result.confirmedIds);
// result.permanentlyFailedIds: surface to user (permission revoked, entity deleted)
// result.retryIds: left in queue automatically
```

### Permission changes

```ts
import { classifyServerError } from "./src/offline";

const { permanent, outcome, description } = classifyServerError({
  status: response.status,
  message: response.statusText,
});
if (permanent) {
  await actionQueue.dequeue(action.operationId);
  showError(description);
}
```

---

## Read-through cache

`CampaignRepository.loadList` / `loadDetail` are network-first: a successful
fetch refreshes the cache, and a failed fetch transparently falls back to the
last cached payload (`fromCache: true`). If nothing is cached the caller can
supply a `fallback` (e.g. `[]` for the browse list) or the original error is
re-thrown.

---

## Wiring into an app

### 1. Storage

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { configureOfflineStorage } from "./src/offline";

configureOfflineStorage(AsyncStorage);
```

For sensitive data, wrap with `EncryptedKeyValueStorage` first (see #87 above).

### 2. Connectivity

```ts
import NetInfo from "@react-native-community/netinfo";
import {
  createConnectivityMonitor,
  bindSyncOnReconnect,
  WishlistSyncEngine,
} from "./src/offline";

const monitor = createConnectivityMonitor({
  subscribe: (listener) =>
    NetInfo.addEventListener((state) => listener(!!state.isConnected)),
});

bindSyncOnReconnect(monitor, { engine: syncEngine });
```

---

## Tests

```bash
pnpm --filter @fundable/mobile test        # vitest run (all offline tests)
pnpm --filter @fundable/mobile typecheck   # tsc --noEmit
```

Coverage:

- `__tests__/campaignCache.test.ts` — cache write → offline read; empty-cache
  fallback and error re-throw; namespace isolation.
- `__tests__/wishlist.test.ts` — offline add/remove persistence across restarts;
  idempotency.
- `__tests__/sync.test.ts` — queue collapse; flush without duplicates; failed
  ops stay queued; flush happens only on reconnect.
- `__tests__/offlineFlow.test.ts` — end-to-end offline browse → wishlist edits →
  sync-on-reconnect; empty-cache offline path.
- `__tests__/encryptedStorage.test.ts` — cipher round-trips; corruption recovery;
  schema migration; `clearSensitiveStorage`; `EncryptedKeyValueStorage`.
- `__tests__/actionQueue.test.ts` — stable operationId across crashes; failed
  actions stay queued; in-flight not re-run; attemptCount increments.
- `__tests__/conflictResolution.test.ts` — campaign server-wins; wishlist merge;
  permission-change classification; partial sync recovery; campaign list reconciliation.

> Note: the pre-existing `src/screens/CampaignDetailScreen.tsx` imports
> `react-native` / `expo-notifications`, which are not part of this repo's
> dependency manifest. The mobile `typecheck`/`test` scripts therefore scope to
> the pure offline modules. Add the React Native toolchain (or a Jest preset) if
> you want component-level tests too.
