# SDK Event Parser Utility - Testing & Validation Guide

## Assignment Overview

**Task**: Implement a type-safe event parser utility for Fundable smart contract events to help dApp developers consume on-chain events with confidence and minimal boilerplate.

---

## Reproducible Contract Builds

Contract wasm builds must be reproducible: building the same source twice in a
clean, pinned environment must yield byte-identical (normalized) wasm. This is
verified in CI and can be run locally.

### Running the reproducible-build check

```bash
corepack pnpm --filter @fundable/contracts build:reproducible
```

This script:

1. Builds the contracts twice in clean, pinned environments (pinned Rust
toolchain from `rust-toolchain.toml`, locked dependencies).
2. Normalizes each wasm artifact before hashing — stripping legitimate
nondeterministic metadata (see below).
3. Compares the normalized SHA-256 hashes of the two builds and fails if they
differ.

### Normalization and legitimate nondeterministic metadata

Some wasm metadata is legitimately nondeterministic across builds and is
**normalized out** before hashing so it does not cause false mismatches:

- **Build paths** — absolute source/build paths embedded in debug info or
custom sections are stripped.
- **Timestamps** — build timestamps in custom sections are removed.
- **Custom metadata sections** — non-functional producer/build sections are
stripped.

Any difference **outside** these normalized regions is a real reproducibility
failure and must be fixed (e.g. unpinned dependency, nondeterministic codegen).

### Interpreting results

- **Identical normalized hashes** — build is reproducible. ✅
- **Hash mismatch** — a real nondeterminism exists; inspect the diff of the two
artifacts to locate the offending section.
- **Missing/empty artifacts** — the build failed to produce wasm; check the build
log before comparing hashes.

### Automated coverage

The reproducible-build tests are deterministic and do not depend on live funds
or network access. They cover:

- **Success** — two builds produce identical normalized hashes.
- **Failure** — differing artifacts produce a hash mismatch.
- **Boundary cases** — metadata-only differences (paths/timestamps) normalize to
the same hash; empty or missing artifacts are reported as errors rather than
silently passing.

---

## API Contract, Versioning & Lifecycle Testing

This section covers the API surface guarantees: OpenAPI validation, contract tests
generated from the OpenAPI document, the versioning/deprecation policy, and the
end-to-end campaign lifecycle tests. **All of these tests are deterministic and
independent of live funds** — they use controlled storage/RPC stubs and fixtures,
never real accounts or network calls.

### Running OpenAPI validation

The OpenAPI document (`packages/api/openapi.yaml`) is validated in CI. Run it locally with:

```bash
corepack pnpm validate:openapi
```

This checks that the document:

- Parses as valid YAML with no merge conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
- Contains no duplicate or misplaced path entries
- Conforms to OpenAPI 3.0 (required fields, `info`, `paths`, schema shapes)

A failure here means the spec is malformed — fix the document, do not skip the check.

### Running API contract, versioning & lifecycle tests

```bash
corepack pnpm test:api
```

This runs three suites:

1. **Contract tests** — compare the documented request/response schemas, status
   codes, auth requirements, and pagination parameters against representative
   live route handlers. A mismatch between the OpenAPI document and a handler
   fails the suite.
2. **Versioning tests** — assert that breaking changes carry a version bump and
   that deprecated operations are annotated correctly.
3. **Lifecycle tests** — drive a full campaign workflow (creation → funding →
   verification → milestone approval → reporting) against controlled
   storage/RPC, including authorization checks for each step.

### API versioning and sunset policy

- **Version bump rules**: additive, backward-compatible changes (new optional
  fields, new endpoints) are non-breaking and do not require a version bump.
  Removing/renaming fields, changing types, tightening validation, or changing
  status codes are **breaking** and require a major version bump of the API
  surface.
- **Deprecation annotations**: deprecated operations/fields must be marked with
  `deprecated: true` in the OpenAPI document and a description explaining the
  replacement and removal timeline.
- **Deprecation/Sunset headers**: deprecated endpoints respond with
  `Deprecation` (the date deprecation was announced) and `Sunset` (the date the
  endpoint will be removed) headers so clients can migrate before removal.
- **Sunset window**: deprecated endpoints remain available for the documented
  sunset window before removal; removal is treated as a breaking change.

### Extending the contract tests

To cover a new or changed route:

1. Add/update the operation in `packages/api/openapi.yaml` (run
   `pnpm validate:openapi` to confirm it is valid).
2. Add a representative handler fixture under the API test fixtures.
3. Add a contract test asserting the documented schema, status codes, auth, and
   pagination match the handler. Use deterministic fixtures — never live funds.

### Extending the lifecycle tests

Lifecycle tests live alongside the API tests and use controlled storage/RPC
stubs. To extend them:

1. Add a step to the campaign workflow fixture (e.g., a new milestone state).
2. Assert both the success path and the failure/authorization-denied path.
3. Keep all state in-memory or in fixtures so runs are deterministic and do not
   depend on live funds.

---

## ✅ Step-by-Step Testing Process

### **STEP 1: Verify Files Were Created**

Run this command in your terminal to confirm all files exist:

```bash
pnpm --filter @fundable/sdk test             # unit tests (vitest --run)
pnpm --filter @fundable/sdk test -- transactions.test.ts  # one file
pnpm --filter @fundable/sdk test:coverage    # unit tests + coverage report
pnpm --filter @fundable/sdk test:integration # testnet integration (needs network + funded key)
pnpm --filter @fundable/sdk build              # ESM + CJS build with type declarations
pnpm --filter @fundable/sdk lint              # eslint src
pnpm --filter @fundable/sdk format:check      # prettier check
```

## Web (`apps/web`)

```bash
pnpm --filter @fundable/web test              # unit tests (jsdom, excludes e2e/)
pnpm --filter @fundable/web test -- src/lib/__tests__/env.test.ts  # one file
pnpm --filter @fundable/web lint              # next/eslint (repo-wide debt: fork PRs skip this in CI)
pnpm --filter @fundable/web test:e2e             # Playwright (starts dev server per playwright.config.ts)
```

E2E prerequisites: `pnpm install`, Playwright browsers installed, port 3000
free. Specs live in `apps/web/e2e/`.

## Mobile (`apps/mobile`)

The offline layer is pure TypeScript (`src/offline/`); `vitest.config.ts`
includes only `src/offline/**/*.test.ts`, and `tsconfig.json` includes only
`src/offline/**/*.ts` (the `screens/` tree needs the React Native toolchain,
which is not in this repo).

```bash
pnpm --filter @fundable/mobile test       # offline unit tests (node env)
pnpm --filter @fundable/mobile typecheck  # tsc --noEmit (offline modules only)
```

## Contracts (`contracts/`, Rust workspace)

```bash
cd c:\Users\HomePC\Documents\D\stellar_client_os\packages\sdk

# Build the SDK
corepack pnpm run build
```

**Expected Output:** Should compile without errors and generate `dist/` directory:

```
dist/
  index.js
  index.d.ts
  utils/
    events.js
    events.d.ts
```

---

### **STEP 5: Verify Type Definitions**

Check that TypeScript types are correctly exported:

```bash
cd c:\Users\HomePC\Documents\D\stellar_client_os\packages\sdk

# View generated types
type dist/utils/events.d.ts | head -50
```

**Expected Output:** Should show TypeScript interfaces like:

```typescript
export interface PaymentStreamContractEventBase<TPayload>
export type PaymentStreamContractEventType = "FeeCollected" | "StreamDeposit" | ...
export declare function parsePaymentStreamContractEvent(event: ContractEventRaw)
```

---

### **STEP 6: Integration Test - Import in Frontend**

Verify the utility can be imported by frontend code:

```bash
cd c:\Users\HomePC\Documents\D\stellar_client_os\apps\web

# Check if @fundable/sdk can import the new utility
corepack pnpm list @fundable/sdk
```

**Expected Output:** Should show `@fundable/sdk@0.1.0` is available as a workspace dependency.

---

### **STEP 7: Runtime Validation**

Create a quick validation script to test the parser at runtime:

```typescript
// test-events.ts - Create this file temporarily
import {
  parsePaymentStreamContractEvent,
  parsePaymentStreamContractEvents,
} from "@fundable/sdk";

// Test FeeCollected event
const feeEvent = {
  contract_id: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  topic: ["FeeCollected"],
  value: { amount: "1000000", stream_id: "42" },
};

const parsed = parsePaymentStreamContractEvent(feeEvent);
console.log("✓ Parsed event:", parsed);

// Test batch parsing
const events = parsePaymentStreamContractEvents([feeEvent]);
console.log("✓ Batch parsed:", events.length, "events");
```

---

## 📋 Checklist: Validation Points

After completing the steps above, verify these points:

- [ ] `packages/sdk/src/utils/events.ts` exists
- [ ] `packages/sdk/src/__tests__/events.test.ts` exists
- [ ] `packages/sdk/src/index.ts` exports the event utilities
- [ ] All 5 event parser tests pass (✓ src/**tests**/events.test.ts (5))
- [ ] SDK package builds without TypeScript errors
- [ ] Generated `.d.ts` files contain type definitions
- [ ] Event types are available for import: `PaymentStreamContractEvent`, `parsePaymentStreamContractEvent`, etc.
- [ ] Batch parsing function `parsePaymentStreamContractEvents()` is exported
- [ ] Defensive parsing rejects invalid event payloads
- [ ] `corepack pnpm validate:openapi` passes (no conflict markers, valid OpenAPI)
- [ ] `corepack pnpm --filter @fundable/contracts build:reproducible` passes (identical normalized wasm hashes)
