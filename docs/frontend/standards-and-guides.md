# Frontend Standards and Contributor Guide

This document outlines the core architecture, offline reliability, accessibility standards, performance budgets, and internationalized formatting implementations across `@fundable/web`.

---

## 1. Offline Sync Queue & Conflict Recovery (Issue #73)

### Overview
The frontend offline synchronization layer (`apps/web/src/hooks/use-sync-queue.ts`) provides guaranteed mutation capture when network connectivity is lost, with full recovery workflows for errors and synchronization conflicts.

### Failure Classification
Each queued operation tracks failure type via `SyncFailureType`:
- `transient`: Network drops, server 502/503/504 errors, timeouts. Automatically re-attempted with exponential backoff.
- `permanent`: Validation rejections, unauthorized requests (400, 401, 403, 422). Requires user payload correction or discard.
- `stale`: Optimistic updates superseded by subsequent modifications or newer server versions.
- `duplicate`: Transactions already submitted or recorded on-chain.

### Conflict Resolution Strategies
When a conflict occurs (`ConflictDetails`), the original user input is preserved in the queue item rather than being discarded or overwritten:
- **`use_local`**: Overwrites the conflicting server version with the queued local data.
- **`use_server`**: Discards the local changes and accepts the current server state.
- **`merge`**: Combines local modifications on top of the remote state or applies a merged payload.
- **Inline Editing**: Users can edit the JSON payload directly in the `SyncQueueDrawer` before retrying.
- **Discard**: Drops the failed queue item without executing further sync attempts.

### UI Components
- `SyncQueueBanner` (`apps/web/src/components/organisms/SyncQueueBanner.tsx`): Displays floating status alerts for offline status, pending sync, and conflict alerts.
- `SyncQueueDrawer` (`apps/web/src/components/organisms/SyncQueueDrawer.tsx`): Full drawer providing payload inspection, JSON editing, conflict resolution actions, and retry/discard triggers.

---

## 2. WCAG 2.2 AA Accessibility Audits & Journey Standards (Issue #75)

All interactive flows conform to WCAG 2.2 AA standards across the five primary journeys:

### 1. Campaign Journey
- **Progress Indicators**: Funding progress bars must provide `role="progressbar"`, `aria-valuenow`, `aria-valuemin="0"`, `aria-valuemax="100"`, and localized `aria-valuetext`.
- **Target Sizes**: All buttons and controls satisfy the WCAG 2.2 24×24px minimum touch target size (44×44px recommended).

### 2. Wallet Journey
- **Modal Dialogs**: Dialogs use `role="dialog"`, `aria-modal="true"`, with headings linked via `aria-labelledby`.
- **Radiogroups**: Wallet selection utilizes `role="radiogroup"` with keyboard arrow navigation, Space/Enter selection, and `aria-checked` states.
- **Buttons**: Action triggers expose explicit `aria-disabled` states.

### 3. Contribution Journey
- **Form Controls**: Every input has an explicit label (`htmlFor` matching input `id`).
- **Validation**: Required inputs use `aria-required="true"`. Validation errors set `aria-invalid="true"` and associate error descriptions via `aria-describedby` pointing to error messages marked `role="alert"`.
- **Preset Buttons**: Quick-selection buttons expose `aria-pressed` states.

### 4. Verification Journey
- **Landmarks**: Filter sidebars and control panels declare semantic landmarks such as `<aside aria-label="Audit filters">` (`role="complementary"`).
- **Date/Status Inputs**: Inputs include descriptive `<label>` elements and keyboard-navigable controls.

### 5. Admin Journey
- **Navigation Landmarks**: Header bars and sidebars use `<nav aria-label="...">`.
- **Interactive Triggers**: Icon buttons without visual text provide explicit `aria-label` attributes.

---

## 3. Performance Budgets for Discovery & Maps (Issue #76)

### Defined Budgets
Located in `apps/web/src/lib/performance-budgets.ts`:
- **Campaign Discovery (`CAMPAIGN_DISCOVERY_BUDGET`)**:
  - Max Initial JS Size: `350 KB`
  - Max Largest Contentful Paint (LCP): `2500 ms`
  - Max Interaction to Next Paint (INP): `200 ms`
  - Max Filter Execution Latency: `50 ms` (benchmarked on 1,000 campaigns)
- **Map Rendering (`MAP_RENDERING_BUDGET`)**:
  - Max Map JS Bundle Size: `450 KB`
  - Max Marker Render / Cluster Time: `150 ms` (benchmarked on 1,000 stream sites)
  - Max Interaction Latency (pan/zoom): `100 ms`

### Running the Performance Audit
Contributors and CI can run the performance benchmark and regression check anytime:
```bash
pnpm --filter @fundable/web perf:budget
```

Thresholds:
- `< 90%` of budget: `PASS`
- `90% - 100%`: `WARN`
- `> 100%`: `REGRESSION` (triggers failure)

---

## 4. Centralized Locale-Aware Amount & Date Formatting (Issue #77)

### API: `@/lib/formatters`
All numerical, asset, date, and time formatting must use the centralized functions in `apps/web/src/lib/formatters.ts`:

### Asset Precisions & Symbols
- `XLM`: 7 decimal places (Stroops conversion supported)
- `USDC`: 2 decimal places
- `EURC`: 2 decimal places
- `CARBON`: 4 decimal places
- Default fallback: 2 decimal places

### Usage Examples
```typescript
import {
  formatAssetAmount,
  formatStroops,
  stroopsToDecimal,
  decimalToStroops,
  formatUtcDateTime,
  formatUtcDate,
  formatRelativeTime,
} from "@/lib/formatters";

// Amount formatting with locale separators
formatAssetAmount(1234567.89, "XLM", "en-US"); // "1,234,567.8900000 XLM"
formatAssetAmount(1234567.89, "EURC", "de-DE"); // "1.234.567,89 EURC"

// Stroop precision without floating-point errors
formatStroops(10000000n); // "1.0000000 XLM"
stroopsToDecimal(50000000n); // "5"
decimalToStroops("5.1234567"); // 51234567n

// UTC Date and Time
formatUtcDateTime(new Date("2026-03-30T14:45:00Z")); // "2026-03-30 14:45:00 UTC"
formatUtcDate(new Date("2026-03-30T14:45:00Z"));     // "2026-03-30"

// Relative Time
formatRelativeTime(Date.now() - 3600000); // "1 hour ago"
```
