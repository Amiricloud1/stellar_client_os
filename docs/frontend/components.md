# Frontend Components, Telemetry & Analytics Architecture

## Overview

The frontend of the web application (`apps/web`, package `@fundable/web`) is built with Next.js, React 19, and Tailwind CSS, using `shadcn/ui` primitives alongside custom Stellar wallet, campaign, and offline-sync organisms.

## Configuration

The `components.json` file in `apps/web` contains the configuration for `shadcn/ui`. Key settings include:

- **Style**: `new-york`
- **RSC (React Server Components)**: Enabled
- **TSX**: Enabled
- **CSS Variables**: Enabled
- **Aliases**:
  - `@/components`: General-purpose and domain components
  - `@/utils`: Utility functions
  - `@/ui`: `shadcn/ui` components
  - `@/lib`: Core library helpers (analytics authority validation, error sanitization, etc.)
  - `@/hooks`: Custom React hooks

## Core Components and Utilities

### `cn` Utility Function

Located in `src/lib/utils.ts`, the `cn` function merges CSS classes by combining `clsx` and `tailwind-merge`:

```typescript
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

---

## 1. Authoritative Analytics Ledger Validation (#82)

Platform and payment-stream analytics metrics are documented and reconciled against authoritative Stellar/Soroban ledger snapshots via `src/lib/analytics-authority.ts`, `src/services/admin-analytics-dashboard.service.ts`, and `src/graphql/analytics.service.ts`.

### Metric Data Sources & Formulas

| Metric Key | Unit | Authority Origin | Data Source | Deterministic Formula |
| :--- | :--- | :--- | :--- | :--- |
| `activeCampaigns` | `count` | `on-chain-ledger` | Soroban campaign contract instance storage (`status == ACTIVE`) | `count(c in campaigns where c.status === 'ACTIVE')` |
| `totalTreesPlanted` | `trees` | `on-chain-ledger` | Soroban campaign contract verified tree counter (`campaign.treeCount`) | `sum(c.treeCount for c in campaigns)` |
| `totalCo2SequesteredKg` | `kg_co2e` | `derived-estimate` | Derived from verified tree count (`21 kg CO2/tree/yr`) | `sum(c.treeCount * 21 for c in campaigns)` |
| `totalSponsors` | `count` | `on-chain-ledger` | Soroban campaign sponsorship ledger (`campaign.sponsorCount`) | `sum(c.sponsorCount for c in campaigns)` |
| `sponsorGrowthPercent` | `percent` | `indexed-ledger-events` | Sponsorship ledger over trailing 30d vs prior 30d `[now - 60d, now - 30d)` | `previousSponsors === 0 ? (recentSponsors > 0 ? 100 : 0) : round(((recentSponsors - previousSponsors) / previousSponsors) * 1000) / 10` |
| `campaignCompletionRate` | `percent` | `on-chain-ledger` | Soroban campaign status ledger (`COMPLETED` vs total campaigns) | `campaigns.length === 0 ? 0 : round((count(c.status === 'COMPLETED') / campaigns.length) * 1000) / 10` |
| `revenue` | `stroops` | `on-chain-ledger` | Soroban campaign escrow ledger (`campaign.raisedAmount` in stroops) | `sum(BigInt(c.raisedAmount) for c in campaigns where /^\d+$/.test(c.raisedAmount))` |
| `totalStreams` | `count` | `on-chain-ledger` | Soroban `payment_stream` contract stream entries | `count(s in streams)` |
| `activeStreams` | `count` | `on-chain-ledger` | Soroban `payment_stream` contract (`status == Active`) | `count(s in streams where s.status === 'Active')` |
| `totalVolumeUsd` | `usd` | `indexed-ledger-events` | Stream `totalAmount` normalized via oracle USD equivalent | `sum(BigInt(s.usdEquivalent ?? s.totalAmount) for s in streams)` |
| `uniqueAssets` | `count` | `on-chain-ledger` | Distinct token contract addresses (`s.asset`) | `cardinality(set(s.asset for s in streams))` |
| `uniqueRegions` | `count` | `indexed-ledger-events` | Off-chain indexer ISO 3166-1 alpha-2 region tags (fallback `'GLOBAL'`) | `cardinality(set((s.region ?? 'GLOBAL') for s in streams))` |
| `uniqueCategories` | `count` | `indexed-ledger-events` | Off-chain indexer category tags (excluding untagged) | `cardinality(set(s.category for s in streams where Boolean(s.category)))` |
| `averageStreamAmount` | `stroops` | `on-chain-ledger` | Per-asset `totalAmount` in stroops | `streamCount > 0 ? (sum(BigInt(s.totalAmount)) / BigInt(streamCount)).toString() : '0'` |
| `sponsorImpact` | `kg_co2e` | `derived-estimate` | Sender stream volume + `CO2_PER_USD_KG` conversion and percentile rank | `myCo2OffsetKg = round(Number(myVolumeUsd) * CO2_PER_USD_KG * 10) / 10` |

### Freshness, Mismatch & Unavailable States

- **`fresh`**: Authoritative ledger snapshot is present, within `maxStalenessMs` (default 5 minutes), and matches computed metrics.
- **`stale`**: Authoritative ledger snapshot matches computed metrics, but `now - ledgerClosedAt > maxStalenessMs`.
- **`mismatch`**: Computed metrics diverge from the authoritative ledger snapshot (`reason: "ledger_mismatch"`), reporting per-metric discrepancies (`expected`, `actual`, `delta`).
- **`unavailable`**: Authoritative ledger state is missing (`missing_authority`), unreachable (`authority_error`), has an invalid sequence (`invalid_ledger_sequence`), or has a future timestamp beyond clock-skew tolerance (`future_timestamp`).
- **Compatibility / Migration**: `/api/analytics/dashboard` preserves all existing response fields (`updatedAt`, `currencyUnit`, `period`, `metrics`, `monthlyTrend`) and adds `authority` and `metricDefinitions`.

---

## 2. Sentry Sensitive Data Scrubbing (#83)

All client (`src/instrumentation-client.ts`), server (`src/sentry.server.config.ts`), and edge (`src/sentry.edge.config.ts`) Sentry configurations attach `beforeSend: scrubSentryEvent`, `beforeSendTransaction: scrubSentryEvent`, and `beforeBreadcrumb: scrubSentryBreadcrumb` from `src/lib/sanitize-error.ts`.

### Scrubbed Data Categories

1. **Tax IDs (`[TAX_ID_REDACTED]`)**:
   - Patterns: US EIN (`\b\d{2}-\d{7}\b`), US SSN/ITIN (`\b\d{3}-\d{2}-\d{4}\b`), EU/UK VAT numbers.
   - Fields: `taxId`, `tax_id`, `tin`, `ein`, `ssn`, `itin`, `vatId`, `vatNumber`, `partnerRegistrationNumber`, `registrationNumber`.
2. **Wallet Secrets (`[SECRET_KEY_REDACTED]`)**:
   - Patterns: Stellar secret keys (`\bS[A-Z0-9]{50,55}\b`).
   - Fields: `secretKey`, `secret_key`, `privateKey`, `private_key`, `walletSecret`, `mnemonic`, `seedPhrase`, `recoveryPhrase`, `keystore`, `signerSecret`.
3. **Signed Transactions (`[SIGNED_TX_REDACTED]`)**:
   - Patterns: Base64 Stellar `TransactionEnvelope` XDR strings (`\bAAAA(?:AgAAA|AQAAA|AwAAA)[A-Za-z0-9+/=]{20,}`).
   - Fields: `signedTx`, `signedTransaction`, `signedXdr`, `txXdr`, `envelopeXdr`, `transactionXdr`, `rawTransaction`, `xdr`, `signatures`.
4. **Verification & Insurance Evidence (`[EVIDENCE_REDACTED]`)**:
   - Patterns: `ipfs://...` URIs, `/evidence/`, `/verification-evidence/`, `/insurance-evidence/` URLs, and S3/GCS pre-signed query parameters (`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`, `Signature`).
   - Fields & Binary Buffers: `evidence`, `verificationEvidence`, `insuranceEvidence`, `evidenceUrl`, `presignedUrl`, `exif`, `gpsLocations`, `latitude`, `longitude`, `coordinates`, `photoBuffer`, `fileBuffer`, `ArrayBuffer`, and typed arrays.
5. **Sensitive URLs, Headers & Body Fields (`[REDACTED]`)**:
   - Headers/Cookies: `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Admin-Key`, `X-Webhook-Signature`.
   - Body/Query Fields: `password`, `secret`, `token`, `accessToken`, `refreshToken`, `apiKey`, `adminKey`, `bankAccount`, `accountNumber`, `routingNumber`, `iban`, `email`, `creatorEmail`, `phone`.

---

## 3. Responsive Wallet & Campaign Workflows (#84)

Mobile viewports (`320px`–`768px`) are supported without horizontal overflow or inaccessible controls across four primary user workflows:

- **Navigation (`Navbar`, `Header`, `AppSidebar`, `NetworkSwitcher`, `ConnectButton`)**:
  - `Navbar` includes a mobile menu toggle (`data-testid="mobile-nav-toggle"`, `aria-expanded`, `aria-controls="mobile-navigation-menu"`) and collapsible drawer (`Escape` key and link-click dismissal) with `overflow-x-clip`.
  - `AppSidebar` renders a bottom navigation bar on mobile viewports with `Campaigns`, `aria-current="page"`, and `overflow-x-hidden`.
- **Wallet Modal (`WalletModal` & `DialogContent`)**:
  - Uses `w-[calc(100vw-2rem)] max-w-sm sm:max-w-md max-h-[90dvh] overflow-y-auto mx-auto` so the centered dialog never shifts off-screen on narrow viewports.
- **Campaign Contribution (`CampaignDonationPanel` & `OneTimeDonationButton`)**:
  - Stacks amount input and full-width token selector on mobile (`w-full sm:w-auto`), wraps long receipt references/addresses (`break-all`, `flex-wrap`), and constrains modal width to `max-w-[calc(100vw-2rem)]`.
- **Offline Sync Queue (`SyncQueueBanner` & `SyncQueueDrawer`)**:
  - `SyncQueueBanner` wraps cleanly on small viewports (`flex-wrap sm:flex-nowrap`) and opens `SyncQueueDrawer` as a bottom sheet (`side="bottom"`, `max-h-[85dvh]`) with `min-h-9 min-w-9` per-item retry and remove touch targets.

---

## 4. Storybook Component States & Static Build Verification (#85)

Core UI components (`Button`, `FormField`, `Modal`, and `ProductCard` / `FeatureCard`) define stories for all six standard operational states in `src/stories/components/*.stories.tsx`:

- `Default`
- `Loading` (`aria-busy="true"`, skeleton/spinner feedback)
- `Empty` (placeholder / zero-data guidance)
- `Error` (`role="alert"`, destructive/validation feedback)
- `Disabled` (`disabled` / `aria-disabled="true"`)
- `Success` (`role="status"`, confirmation badge/message)

### Building & Verifying Storybook in CI

Run the deterministic static Storybook builder and verifier:

```bash
pnpm --filter @fundable/web build-storybook
```

This executes `apps/web/scripts/build-storybook.mjs`, which validates `.storybook/main.js` and `.storybook/preview.js` stylesheet imports, verifies that every core component defines `Default`, `Loading`, `Empty`, `Error`, `Disabled`, and `Success` stories, copies static assets from `public/`, emits `storybook-static/` (`index.html`, `iframe.html`, `index.json`, `stories.json`, `project.json`, `styles.css`), and verifies the resulting build artifacts.
