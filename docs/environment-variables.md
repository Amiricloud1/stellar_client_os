# Environment-variable reference

Single inventory of every environment variable read by this repository.
Checked against the runtime schemas: `apps/web/src/lib/env.ts` (`envSchema` /
`validateEnv`), `apps/web/src/lib/s3/config.ts` (`s3ConfigSchema` /
`loadS3Config`), and the direct `process.env.*` reads listed per row.

Conventions:

- **Scope `client`** (`NEXT_PUBLIC_*`) is inlined into the browser bundle at
  build time - never put secrets there. Everything else is **server-only**.
- **Secret = yes** means the value is a credential and must never be committed,
  logged, or pasted into issues/PRs.
- Unless stated otherwise, an unset optional variable falls back to the default
  shown; an unset required variable fails startup loudly (web `validateEnv()`,
  S3 `loadS3Config()`, or the script's own guard).

## Web client (`NEXT_PUBLIC_*`, validated by `envSchema`)

| Name | Required / default | Secret | Validation rule |
| ---- | ------------------ | ------ | --------------- |
| `NEXT_PUBLIC_PAYMENT_STREAM_CONTRACT_ID` | required | no | non-empty, starts with `C` |
| `NEXT_PUBLIC_DISTRIBUTOR_CONTRACT_ID` | required | no | non-empty, starts with `C` |
| `NEXT_PUBLIC_PLANTER_CONTRACT_ID` | optional | no | starts with `C` when set |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | default `https://soroban-testnet.stellar.org` | no | valid URL |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | default `Test SDF Network ; September 2015` | no | non-empty |
| `NEXT_PUBLIC_STELLAR_NETWORK` | default `testnet` | no | `testnet` \| `mainnet` |
| `NEXT_PUBLIC_STELLAR_HORIZON_URL` | optional (`""` allowed) | no | valid URL when set |
| `NEXT_PUBLIC_USDT_CONTRACT_ID` | optional (`""` allowed) | no | starts with `C` when set |
| `NEXT_PUBLIC_EURC_CONTRACT_ID` | optional (`""` allowed) | no | starts with `C` when set |
| `NEXT_PUBLIC_URL` | optional | no | valid URL when set |
| `NEXT_PUBLIC_APP_NAME` | optional | no | any string |
| `NEXT_PUBLIC_APP_DESCRIPTION` | optional | no | any string |
| `NEXT_PUBLIC_API_URL` | optional (`""` allowed) | no | valid URL when set |
| `NEXT_PUBLIC_BACKEND_BASE_URL` | optional (`""` allowed) | no | valid URL when set |
| `NEXT_PUBLIC_POLYGON_RPC_URL` | optional | no | valid URL when set |
| `NEXT_PUBLIC_OFFRAMP_MOCK` | optional | no | `"true"` enables the off-ramp mock |
| `NEXT_PUBLIC_OFFRAMP_MOCK_DELAYS` | optional | no | comma-separated ms (offramp mock) |
| `NEXT_PUBLIC_OFFRAMP_MOCK_FAIL_RATE` | optional, default `"0"` | no | numeric failure probability |
| `NEXT_PUBLIC_OFFRAMP_MOCK_FAIL_STEP` | optional, default `""` | no | step name forced to fail |
| `NEXT_PUBLIC_SENTRY_DSN` | optional | no | when set, Sentry enables; unset stays disabled |
| `NEXT_PUBLIC_ERROR_REPORTING_ENDPOINT` | optional | no | custom error-reporting endpoint |

## Web server (server-only)

| Name | Required / default | Secret | Validation rule / read site |
| ---- | ------------------ | ------ | --------------------------- |
| `AWS_REGION` | required (S3 uploads) | no | non-empty (`s3ConfigSchema`) |
| `AWS_S3_BUCKET` | required (S3 uploads) | no | non-empty (`s3ConfigSchema`) |
| `AWS_ACCESS_KEY_ID` | required (S3 uploads) | **yes** | non-empty (`s3ConfigSchema`) |
| `AWS_SECRET_ACCESS_KEY` | required (S3 uploads) | **yes** | non-empty (`s3ConfigSchema`) |
| `AWS_SESSION_TOKEN` | optional | **yes** | STS temporary credentials |
| `S3_PRESIGN_EXPIRES_SECONDS` | default `300` | no | integer `60..900` |
| `ADMIN_API_KEY` | optional (fail-closed) | **yes** | unset -> admin endpoints answer 503 (`lib/admin-auth.ts`) |
| `CARBON_MARKET_ADMIN_TOKEN` | optional (fail-closed) | **yes** | Bearer match (`api/carbon-credits/errors.ts`) |
| `VERIFICATION_INSURANCE_ADMIN_TOKEN` | optional (fail-closed) | **yes** | Bearer match (verification-insurance route) |
| `TWITTER_BEARER_TOKEN` | optional | **yes** | X API token; endpoint degrades without it |
| `REDIS_URL` | default `redis://localhost:6379` (non-prod); unset in prod disables rate limiting | **yes** | connection string (`lib/redis.ts`) |
| `REDIS_CONNECT_TIMEOUT` | default `2000` (ms) | no | number |
| `REDIS_COMMAND_TIMEOUT` | default `500` (ms) | no | number |
| `RATE_LIMIT_MAX_REQUESTS` | default `60` | no | number |
| `RATE_LIMIT_WINDOW_MS` | default `60000` | no | number (ms) |
| `RATE_LIMIT_KEY_PREFIX` | default `rl` | no | string |
| `RATE_LIMIT_STREAM_MAX` | default `30` | no | number |
| `RATE_LIMIT_SUBMIT_MAX` | default `10` | no | number |
| `RATE_LIMIT_SKIP_IPS` | optional | no | comma-separated IPs always allowed |
| `GEO_CACHE_BBOX_TTL_SECONDS` | default `30` | no | number (s) |
| `GEO_CACHE_RADIUS_TTL_SECONDS` | default `60` | no | number (s) |
| `GEO_CACHE_AGGS_TTL_SECONDS` | default `120` | no | number (s) |
| `GEO_CACHE_DETAIL_TTL_SECONDS` | default `300` | no | number (s) |
| `CAMPAIGN_PROGRESS_CACHE_TTL_SECONDS` | default (see `lib/campaign-progress-cache.ts`) | no | number (s) |
| `GRAPHQL_BODY_LIMIT_BYTES` | default `102400` (100 KB) | no | number (bytes) |
| `CO2_PER_USD_KG` | default `1` | no | number (kg CO2e per USD) |
| `FRAUD_MAX_TREES_PER_DAY` | default `2000` | no | number |
| `FRAUD_LOCATION_TOLERANCE_KM` | default `50` | no | number (km) |
| `PHASH_HAMMING_THRESHOLD` | default `10` | no | number (bits) |
| `PHASH_HASH_TTL_MS` | default (see `services/phash.service.ts`) | no | number (ms) |
| `RAINY_SEASON_MONTHS` | default (see `services/campaign-rewards.service.ts`) | no | comma-separated months |
| `IPFS_GATEWAY_URL` | optional | no | URL prefix for `ipfs/<cid>` links |
| `STELLAR_SERVER_URL` | optional | no | Stellar RPC fallback |
| `STELLAR_RPC_URL` | default testnet URL (scripts) | no | valid URL |
| `SOROBAN_RPC_URL` | optional legacy alias | no | prefer `STELLAR_RPC_URL` |
| `SOROBAN_NETWORK_PASSPHRASE` | optional legacy alias | no | prefer `NETWORK_PASSPHRASE` |
| `NETWORK_PASSPHRASE` | default testnet passphrase (scripts) | no | network passphrase |
| `NODE_ENV` | default unset (dev) | no | `development` \| `production` \| `test` |
| `CI` | optional | no | Playwright: retries 2, 1 worker, fresh server |

## Scripts / ops (`scripts/`, deployments)

| Name | Required / default | Secret | Validation rule |
| ---- | ------------------ | ------ | --------------- |
| `NETWORK` | required for deploy | no | `testnet` \| `mainnet` |
| `STELLAR_SECRET_KEY` | required for deploy | **yes** | Stellar secret seed |
| `TESTNET_NETWORK_PASSPHRASE` | required for testnet deploy | no | testnet passphrase |
| `MAINNET_NETWORK_PASSPHRASE` | required for mainnet deploy | no | mainnet passphrase |
| `BOT_SECRET_KEY` | required for TTL bot | **yes** | seed paying rent-bump txs |
| `CONTRACT_IDS` | required for TTL bot / CDC indexer | no | comma-separated contract IDs |
| `DATABASE_URL` | required for CDC indexer | **yes** | Postgres connection string |
| `WARNING_THRESHOLD_LEDGERS` | default `50000` | no | number (ledgers) |
| `EXTEND_TO_LEDGERS` | default `500000` | no | number (ledgers) |
| `POLL_INTERVAL_SECONDS` | default `300` (TTL bot) / `5` (indexer) | no | number (s) |
| `LEDGER_LOOKBACK` | default `1000` | no | number (ledgers) |
| `MAX_EVENTS_PER_POLL` | default `200` | no | number |
| `MAX_RETRIES` | default `3` | no | number |
| `INDEXER_ID` | default `fundable_stream_indexer` | no | cursor-row identifier |
| `DRY_RUN` | default `false` | no | `"true"` = no writes |
| `DISTRIBUTOR_WASM_PATH` | optional | no | path override for deploy |
| `PAYMENT_STREAM_WASM_PATH` | optional | no | path override for deploy |
| `TRENDING_VELOCITY_WEIGHT` / `TRENDING_ENGAGEMENT_WEIGHT` / `TRENDING_COMPLETION_WEIGHT` | defaults `0.4` / `0.3` / `0.3` | no | clamped non-negative, renormalised |
| `ANCHOR_SECRET_KEY` | optional (dev fallback) | **yes** | set explicitly in shared envs |
| `TEST_SECRET_KEY` | test-only | **yes** | never a funded key |

## Compatibility / migration notes

- Additive-only: new optional variables ship with a default or fail-open path
  and are added here. Promoting an optional variable to required is a breaking
  change - call it out in the PR (migrations section) and in `.env.example`.
- `NEXT_PUBLIC_*` values bake into the client bundle at build time; rotating
  one requires a rebuild + redeploy, while server-only values rotate with a
  restart.
- `SOROBAN_RPC_URL` / `SOROBAN_NETWORK_PASSPHRASE` are legacy aliases kept for
  existing deployments; new setups use `STELLAR_RPC_URL` / `NETWORK_PASSPHRASE`
  (scripts) and `NEXT_PUBLIC_SOROBAN_RPC_URL` (web).
- Consistency between this doc, `.env.example`, and the zod schemas is pinned
  by `apps/web/src/lib/__tests__/env-reference.test.ts` (runs in CI).
