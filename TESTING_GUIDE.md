# Testing Guide

Linux-compatible commands for every workspace, verified against the scripts in
`package.json`, `apps/*/package.json`, and `packages/sdk/package.json`.
Run from the repository root unless noted. This repo uses **pnpm exclusively**
- `npm install` / `yarn` create lockfiles that fail CI (`sdk-ci.yml` rejects
  `package-lock.json` / `yarn.lock`).

> Prerequisites: Node.js 18+, pnpm 8+, Rust + Soroban CLI 25+ (contracts only),
> Playwright browsers for E2E (`pnpm --filter @fundable/web exec playwright install`).
> Contract tests need `cargo`; without it, state `cargo unavailable` in your PR.

## Quick reference

| Area | Command |
| ---- | ------- |
| SDK unit tests | `pnpm --filter @fundable/sdk test` |
| SDK coverage | `pnpm --filter @fundable/sdk test:coverage` |
| SDK integration (testnet) | `pnpm --filter @fundable/sdk test:integration` |
| SDK build (ESM + CJS) | `pnpm --filter @fundable/sdk build` |
| SDK lint / format | `pnpm --filter @fundable/sdk lint` / `pnpm --filter @fundable/sdk format:check` |
| Web unit tests | `pnpm --filter @fundable/web test` |
| Single web file | `pnpm --filter @fundable/web test -- src/lib/__tests__/env.test.ts` (see note) |
| Web lint | `pnpm --filter @fundable/web lint` |
| Web E2E | `pnpm --filter @fundable/web test:e2e` (Playwright, needs dev server + browsers) |
| Mobile offline tests | `pnpm --filter @fundable/mobile test` |
| Mobile typecheck | `pnpm --filter @fundable/mobile typecheck` |
| Contracts build | `pnpm build:contracts` (or `cd contracts && cargo build --release`) |
| Contracts tests | `pnpm test:contracts` (or `cd contracts && cargo test`) |

Note: `pnpm --filter <pkg> test -- <args>` forwards `<args>` to the package
script. The web `test` script is `vitest run`, so `-- <path>` filters spec
files; the SDK `test` script is `vitest --run` with the same forwarding.

## SDK (`packages/sdk`)

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
pnpm build:contracts   # cargo build --release
pnpm test:contracts    # cargo test --all
```

Requires the Rust toolchain (`rustup`) and, for builds, the Soroban CLI.
`contracts.yml` runs `cargo test --all` with `continue-on-error: true`, so
check its log even on green CI.

## CI mapping

| Workflow | Trigger paths | What runs |
| -------- | ------------- | --------- |
| `contracts.yml` | push / PR (all) | `cargo test --all` (continue-on-error) |
| `frontend.yml` | push / PR (skips fork PRs) | install, generate `.env.local` from `deployments/testnet.json`, `pnpm lint` |
| `sdk.yml` | `packages/sdk/**` | lint, format check, test, build |
| `sdk-ci.yml` | `packages/sdk/**` | coverage + ESM/CJS consumer compat |
| `docs.yml` | docs/offline/env/template paths | web docs tests, mobile offline tests, markdown checks |

## Troubleshooting

- `pnpm install --frozen-lockfile` fails: run plain `pnpm install` locally,
  but never commit a `package-lock.json` / `yarn.lock`.
- Mobile `typecheck`/`test` ignore `src/screens/`: expected (see above).
- Web `lint` fails on `main` for unrelated files: pre-existing debt, also
  noted in `frontend.yml`; only fix files your PR touches.
