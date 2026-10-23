# SDK Recipes

Copy-pasteable patterns for wallet integration, RPC provider setup,
transaction lifecycle management, and event consumption using the
`@fundable/sdk`.

These recipes are deterministic and do not require live funds — they
work against testnet, local standalone, or mocked RPC endpoints.

---

## Wallet Recipes

### Wallet Adapter Interface

Implement the `WalletAdapter` interface to connect any Stellar wallet
to the SDK's signing helpers (`signAndSend`, `signAndWait`).

```typescript
import { WalletAdapter } from "@fundable/sdk";

const myWallet: WalletAdapter = {
  name: "MyWallet",
  connected: false,
  address: null,
  async connect() {
    const address = await window.myWallet.connect();
    this.connected = true;
    this.address = address;
    return address;
  },
  async disconnect() {
    await window.myWallet.disconnect();
    this.connected = false;
    this.address = null;
  },
  async signTransaction(xdr) {
    const signed = await window.myWallet.signTransaction(xdr);
    return signed;
  },
};
```

### Connecting to a Wallet

Use `connectWallet` for consistent connection handling across
providers:

```typescript
import { connectWallet } from "@fundable/sdk";

const result = await connectWallet(myWallet);
if (result.success) {
  console.log("Connected:", result.address);
} else {
  console.error("Connection failed:", result.error);
}
```

### Signing Transactions

Use `signTransactionWithWallet` to wrap wallet signing with safe error
recovery:

```typescript
import { signTransactionWithWallet } from "@fundable/sdk";

try {
  const signedXdr = await signTransactionWithWallet(wallet, unsignedXdr);
  await tx.signAndSend({
    signTransaction: () => Promise.resolve({ signedTxXdr: signedXdr }),
  });
} catch (error) {
  if (error.message.includes("rejected")) {
    // User cancelled — show UI prompt to retry
  } else {
    // Provider or network error — show error message
  }
}
```

### Test Wallet (Development Only)

`createTestWallet` creates an in-memory adapter from a secret key for
local development and testing. **Not for production use.**

```typescript
import { createTestWallet } from "@fundable/sdk";

const wallet = createTestWallet("SAAAA...");
await wallet.connect();
const signed = await wallet.signTransaction(unsignedXdr);
```

---

## RPC Provider Recipes

### Preset Network Configurations

Use `getRpcProviderConfig` for standard network presets:

```typescript
import { getRpcProviderConfig } from "@fundable/sdk";

const testnet = getRpcProviderConfig("testnet");
// { network: "testnet", networkPassphrase: "...", rpcUrl: "...", ... }

const mainnet = getRpcProviderConfig("mainnet");
// { network: "mainnet", networkPassphrase: "...", rpcUrl: "...", ... }

const local = getRpcProviderConfig("local");
// { network: "local", networkPassphrase: "...", rpcUrl: "http://localhost:8000", allowHttp: true }
```

Override individual fields when needed:

```typescript
const config = getRpcProviderConfig("testnet", {
  rpcUrl: "https://custom-rpc.example.com",
});
```

### RPC Server Options

`getRpcServerOptions` returns the `{ allowHttp }` options object for
constructing Stellar RPC servers, enforcing the same security rules as
the SDK:

```typescript
import { getRpcServerOptions } from "@fundable/sdk";

const options = getRpcServerOptions("https://soroban-testnet.stellar.org");
// { allowHttp: false }

const localOptions = getRpcServerOptions("http://localhost:8000", true);
// { allowHttp: true }
```

Use `isLocalRpcUrl` to check whether a URL is a plain-HTTP loopback
endpoint safe for local development:

```typescript
import { isLocalRpcUrl } from "@fundable/sdk";

isLocalRpcUrl("http://localhost:8000");   // true
isLocalRpcUrl("https://soroban-testnet.stellar.org"); // false
```

---

## Transaction Recipes

### Execute with Error Recovery

`executeTransaction` signs, sends, and waits for confirmation, returning
a discriminated outcome instead of throwing:

```typescript
import { executeTransaction } from "@fundable/sdk";

const outcome = await executeTransaction(
  tx,
  "https://soroban-testnet.stellar.org",
  (xdr) => wallet.signTransaction(xdr),
  { timeout: 90000 },
);

if (outcome.success) {
  console.log("Confirmed in ledger:", outcome.ledger);
  console.log("Result:", outcome.result);
} else {
  console.error("Failed:", outcome.error?.message);
  console.error("Suggestion:", outcome.error?.suggestion);
}
```

### Wait for Transaction

`waitForTransactionWithRetry` waits for an already-sent transaction,
handling "not found" during propagation automatically:

```typescript
import { waitForTransactionWithRetry } from "@fundable/sdk";

await tx.signAndSend({ signTransaction: (xdr) => wallet.signTransaction(xdr) });

try {
  const result = await waitForTransactionWithRetry(tx, rpcUrl);
  console.log("Confirmed:", result.result);
} catch (error) {
  // Transaction failed or timed out — use result.hash for manual lookup
}
```

### Safe Cancellation

`cancelStreamSafely` demonstrates the cancellation pattern for any
contract with a cancel method:

```typescript
import { cancelStreamSafely } from "@fundable/sdk";

const cancelTx = await client.cancelStream({ streamId: 123n });
const outcome = await cancelStreamSafely(cancelTx, rpcUrl, signer);

if (!outcome.success) {
  // Stream may still be active — verify on-chain state before retrying
  console.error("Cancellation failed:", outcome.error?.message);
}
```

### Classify Retryable Errors

`isRetryableError` helps decide whether to retry or show an error:

```typescript
import { isRetryableError } from "@fundable/sdk";

if (isRetryableError(error)) {
  // Retry with exponential backoff
  await retryWithBackoff(operation, 3);
} else {
  // Show to user — retrying won't help
  showErrorDialog(error);
}
```

---

## Event Consumption Recipes

### Consume Contract Events

`consumeContractEvents` parses raw Soroban events into typed
payment-stream events:

```typescript
import { consumeContractEvents } from "@fundable/sdk";

const rawEvents = await server.getEvents({ contractIds: [contractId] });
const result = consumeContractEvents(rawEvents);

for (const event of result.parsedEvents) {
  console.log(`${event.type}:`, event.payload);
}

if (result.unparsedEvents.length > 0) {
  console.warn(`${result.unparsedEvents.length} events could not be parsed`);
}
```

### Filter Events by Type

```typescript
import { filterEventsByType } from "@fundable/sdk";

const deposits = filterEventsByType(result.parsedEvents, "StreamDeposit");
```

### Group Events by Contract

```typescript
import { groupEventsByContract } from "@fundable/sdk";

const byContract = groupEventsByContract(result.parsedEvents);
```

### Convenience Helpers

```typescript
import { getStreamDeposits, getStreamPauses } from "@fundable/sdk";

const deposits = getStreamDeposits(result.parsedEvents);
const pauses = getStreamPauses(result.parsedEvents);
```

---

## Testing

All recipes include automated tests in
`packages/sdk/src/__tests__/recipes/`. Run them with:

```bash
pnpm --filter @fundable/sdk test
```

Tests are deterministic and do not require live funds — they mock RPC
responses and wallet signing callbacks.
